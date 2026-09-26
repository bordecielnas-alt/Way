import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, llm, search, type SearchHit } from '@way/providers';

// Provider router (brief §8.4): one entry point per layer, quota counters,
// circuit breaker, routing by task, degraded mode when everything is spent.

export type Task = 'extract' | 'write';

interface ProviderDef {
  type: 'search' | 'llm';
  adapter?: 'wikipedia' | 'tavily' | 'brave' | 'searxng';
  baseUrl?: string;
  keyEnv?: string;
  urlEnv?: string;
  urlSuffix?: string;
  model?: string;
  perMinute: number;
  perDay: number;
  timeoutMs?: number;
}

export interface RouterConfig {
  providers: Record<string, ProviderDef>;
  routes: { search: string[]; extract: string[]; write: string[] };
  breaker: { failures: number; cooldownMinutes: number };
  headroom: number;
}

export interface ProviderStatus {
  id: string;
  type: 'search' | 'llm';
  model: string | null;
  configured: boolean;
  available: boolean;
  minute: { used: number; limit: number };
  day: { used: number; limit: number };
  breakerOpenUntil: number | null;
  calls: number;
  failures: number;
  avgLatencyMs: number | null;
  lastError: string | null;
}

interface State {
  minute: number[]; // call timestamps within the last minute
  day: number;
  failuresInRow: number;
  openUntil: number;
  calls: number;
  failures: number;
  latencyTotal: number;
  lastError: string | null;
}

const DEFAULT_FILE = fileURLToPath(new URL('../providers.default.json', import.meta.url));

export function loadRouterConfig(file = process.env.PROVIDERS_FILE || DEFAULT_FILE): RouterConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as RouterConfig;
}

const today = () => new Date().toISOString().slice(0, 10);

export class ProviderRouter {
  private state = new Map<string, State>();
  private day = today();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: RouterConfig,
    private env: NodeJS.ProcessEnv = process.env,
    /** Daily counters survive restarts here (free quotas are daily). */
    private usageFile: string | null = null,
  ) {
    for (const id of Object.keys(cfg.providers)) this.state.set(id, blank());
    if (usageFile && existsSync(usageFile)) {
      try {
        const u = JSON.parse(readFileSync(usageFile, 'utf8')) as { day: string; counts: Record<string, number> };
        if (u.day === this.day) for (const [id, n] of Object.entries(u.counts)) if (this.state.has(id)) this.state.get(id)!.day = n;
      } catch {
        /* corrupt counters: start from zero */
      }
    }
  }

  /** Is at least one LLM usable for `task` right now? */
  canRun(task: Task): boolean {
    return this.cfg.routes[task].some((id) => this.available(id));
  }

  /** Configured at all (keys present), regardless of quotas. */
  hasProvider(task: Task): boolean {
    return this.cfg.routes[task].some((id) => this.configured(id));
  }

  /**
   * Web search down the chain: providers are called in order until `want`
   * distinct pages are collected (Wikipedia alone often suffices).
   */
  async search(query: string, want = 6): Promise<SearchHit[]> {
    const out = new Map<string, SearchHit>();
    for (const id of this.cfg.routes.search) {
      if (out.size >= want) break;
      if (!this.available(id)) continue;
      const def = this.cfg.providers[id]!;
      const hits = await this.call(id, 'search', () => {
        switch (def.adapter) {
          case 'wikipedia': return search.wikipediaSearch('fr', query, 4);
          case 'tavily': return search.tavilySearch(this.key(id)!, query);
          case 'brave': return search.braveSearch(this.key(id)!, query);
          case 'searxng': return search.searxngSearch(this.url(id)!, query);
          default: throw new Error(`unknown search adapter ${def.adapter}`);
        }
      });
      for (const h of hits ?? []) if (!out.has(h.url)) out.set(h.url, h);
    }
    return [...out.values()].slice(0, want);
  }

  /**
   * JSON completion for a task. Falls back to the next provider on errors and
   * on answers `parse` rejects. Returns null in degraded mode.
   */
  async completeJson<T>(
    task: Task, system: string, user: string, parse: (value: unknown) => T,
  ): Promise<{ value: T; provider: string } | null> {
    for (const id of this.cfg.routes[task]) {
      if (!this.available(id)) continue;
      const def = this.cfg.providers[id]!;
      const value = await this.call(id, task, async () => {
        const text = await llm.chat({
          baseUrl: this.url(id)!,
          apiKey: this.key(id) ?? undefined,
          model: this.model(id)!,
          system,
          user,
          json: true,
          timeoutMs: def.timeoutMs,
        });
        return parse(llm.parseJsonObject(text));
      });
      if (value !== undefined) return { value, provider: id };
    }
    return null;
  }

  status(): ProviderStatus[] {
    this.rollDay();
    const now = Date.now();
    return Object.entries(this.cfg.providers).map(([id, def]) => {
      const s = this.state.get(id)!;
      return {
        id,
        type: def.type,
        model: def.type === 'llm' ? this.model(id) : null,
        configured: this.configured(id),
        available: this.available(id),
        minute: { used: s.minute.filter((t) => now - t < 60_000).length, limit: def.perMinute },
        day: { used: s.day, limit: def.perDay },
        breakerOpenUntil: s.openUntil > now ? s.openUntil : null,
        calls: s.calls,
        failures: s.failures,
        avgLatencyMs: s.calls ? Math.round(s.latencyTotal / s.calls) : null,
        lastError: s.lastError,
      };
    });
  }

  // ---------- internals ----------

  private async call<T>(id: string, task: string, fn: () => Promise<T>): Promise<T | undefined> {
    const s = this.state.get(id)!;
    const started = Date.now();
    s.minute.push(started);
    s.day++;
    s.calls++;
    this.scheduleSave();
    try {
      const value = await fn();
      s.failuresInRow = 0;
      s.latencyTotal += Date.now() - started;
      console.log(`[router] ${task} via ${id}: ok in ${Date.now() - started} ms`);
      return value;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      s.failures++;
      s.failuresInRow++;
      s.latencyTotal += Date.now() - started;
      s.lastError = msg;
      const cooldown = this.cfg.breaker.cooldownMinutes * 60_000;
      // Quota errors open the breaker at once; others after a few in a row.
      const quota = e instanceof HttpError && (e.status === 429 || e.status === 402);
      if (quota || s.failuresInRow >= this.cfg.breaker.failures) s.openUntil = Date.now() + cooldown;
      console.warn(`[router] ${task} via ${id}: failed in ${Date.now() - started} ms: ${msg}`);
      return undefined;
    }
  }

  private configured(id: string): boolean {
    const def = this.cfg.providers[id];
    if (!def) return false;
    if (def.keyEnv && !this.env[def.keyEnv]) return false;
    if (def.urlEnv && !this.env[def.urlEnv]) return false;
    return true;
  }

  private available(id: string): boolean {
    if (!this.configured(id)) return false;
    this.rollDay();
    const def = this.cfg.providers[id]!;
    const s = this.state.get(id)!;
    const now = Date.now();
    if (s.openUntil > now) return false;
    s.minute = s.minute.filter((t) => now - t < 60_000);
    // Switch before hitting the provider's limit.
    return s.minute.length < Math.max(1, Math.floor(def.perMinute * this.cfg.headroom))
      && s.day < Math.max(1, Math.floor(def.perDay * this.cfg.headroom));
  }

  private key(id: string): string | null {
    const env = this.cfg.providers[id]?.keyEnv;
    return env ? (this.env[env] ?? null) : null;
  }

  private url(id: string): string | null {
    const def = this.cfg.providers[id]!;
    if (def.urlEnv) {
      const base = this.env[def.urlEnv];
      return base ? base.replace(/\/$/, '') + (def.urlSuffix ?? '') : null;
    }
    return def.baseUrl ?? null;
  }

  private model(id: string): string | null {
    const envName = `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODEL`;
    return this.env[envName] || this.cfg.providers[id]?.model || null;
  }

  private rollDay(): void {
    const d = today();
    if (d === this.day) return;
    this.day = d;
    for (const s of this.state.values()) s.day = 0;
  }

  private scheduleSave(): void {
    if (!this.usageFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const counts = Object.fromEntries([...this.state].map(([id, s]) => [id, s.day]));
      try {
        mkdirSync(dirname(this.usageFile!), { recursive: true });
        writeFileSync(this.usageFile!, JSON.stringify({ day: this.day, counts }));
      } catch (e) {
        console.warn('[router] could not save usage:', (e as Error).message);
      }
    }, 2000);
    this.saveTimer.unref();
  }
}

function blank(): State {
  return { minute: [], day: 0, failuresInRow: 0, openUntil: 0, calls: 0, failures: 0, latencyTotal: 0, lastError: null };
}
