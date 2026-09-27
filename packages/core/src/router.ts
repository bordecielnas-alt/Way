import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, llm, search, type SearchHit } from '@way/providers';
import type { SettingsData } from './settings.ts';

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
  /** Model from the providers file, before any override. */
  defaultModel: string | null;
  /** Variables this provider reads (API key, URL, model override). */
  keyEnv: string | null;
  urlEnv: string | null;
  modelEnv: string | null;
  configured: boolean;
  /** Turned off from the settings page. */
  disabled: boolean;
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
    private baseEnv: NodeJS.ProcessEnv = process.env,
    /** Daily counters survive restarts here (free quotas are daily). */
    private usageFile: string | null = null,
    /** Values saved from the settings page, read on every use. */
    private settings: (() => SettingsData) | null = null,
    /** Level-2 switch when the settings page left it alone (LEVEL2). */
    private level2Default = true,
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

  /** Level 2 (and AI translation) switched on. */
  get enabled(): boolean {
    return this.settings?.().level2 ?? this.level2Default;
  }

  /** Is at least one LLM usable for `task` right now? */
  canRun(task: Task): boolean {
    return this.enabled && this.cfg.routes[task].some((id) => this.available(id));
  }

  /** Configured at all (keys present), regardless of quotas. */
  hasProvider(task: Task): boolean {
    return this.enabled && this.cfg.routes[task].some((id) => this.usable(id));
  }

  /** Variables the settings page may set: keys, URLs and model overrides. */
  variables(): string[] {
    const out = new Set<string>();
    for (const [id, def] of Object.entries(this.cfg.providers)) {
      if (def.keyEnv) out.add(def.keyEnv);
      if (def.urlEnv) out.add(def.urlEnv);
      if (def.type === 'llm') out.add(modelEnv(id));
    }
    return [...out];
  }

  /** Where a variable's value comes from, for the settings page. */
  source(name: string): 'settings' | 'env' | null {
    if (this.settings?.().env[name]) return 'settings';
    return this.baseEnv[name] ? 'env' : null;
  }

  /**
   * One real call to check a key from the settings page. Counts against the
   * quotas like any call, ignores the breaker (the key may just have changed).
   */
  async test(id: string): Promise<{ ok: boolean; ms: number; detail: string }> {
    const def = this.cfg.providers[id];
    if (!def) return { ok: false, ms: 0, detail: 'fournisseur inconnu' };
    if (!this.configured(id)) return { ok: false, ms: 0, detail: 'clé ou adresse manquante' };
    const started = Date.now();
    const s = this.state.get(id)!;
    s.openUntil = 0;
    s.failuresInRow = 0;
    const value = await this.call(id, 'test', async () => {
      if (def.type === 'search') {
        const hits = await this.searchWith(id, 'bataille des Thermopyles');
        if (!hits.length) throw new Error('aucun résultat');
        return `${hits.length} résultat(s), dont « ${hits[0]!.title} »`;
      }
      const text = await llm.chat({
        baseUrl: this.url(id)!,
        apiKey: this.key(id) ?? undefined,
        model: this.model(id)!,
        system: 'Réponds uniquement par un objet JSON.',
        user: 'En quelle année a eu lieu la bataille de Marignan ? Réponds {"annee": nombre}.',
        json: true,
        timeoutMs: Math.min(def.timeoutMs ?? 60_000, 60_000),
      });
      const v = llm.parseJsonObject(text) as { annee?: unknown };
      return `le modèle répond ${JSON.stringify(v).slice(0, 80)}`;
    });
    // A failed test must not pause the provider: the user is fixing it.
    if (value === undefined) s.openUntil = 0;
    const error = s.lastError ?? 'échec';
    const detail = value ?? (/fetch failed|ECONNREFUSED|ENOTFOUND/.test(error) ? 'serveur injoignable à cette adresse' : error);
    return { ok: value !== undefined, ms: Date.now() - started, detail };
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
      const hits = await this.call(id, 'search', () => this.searchWith(id, query));
      for (const h of hits ?? []) if (!out.has(h.url)) out.set(h.url, h);
    }
    return [...out.values()].slice(0, want);
  }

  private searchWith(id: string, query: string): Promise<SearchHit[]> {
    const def = this.cfg.providers[id]!;
    switch (def.adapter) {
      case 'wikipedia': return search.wikipediaSearch('fr', query, 4);
      case 'tavily': return search.tavilySearch(this.key(id)!, query);
      case 'brave': return search.braveSearch(this.key(id)!, query);
      case 'searxng': return search.searxngSearch(this.url(id)!, query);
      default: throw new Error(`unknown search adapter ${def.adapter}`);
    }
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
        defaultModel: def.model ?? null,
        keyEnv: def.keyEnv ?? null,
        urlEnv: def.urlEnv ?? null,
        modelEnv: def.type === 'llm' ? modelEnv(id) : null,
        configured: this.configured(id),
        disabled: this.disabled(id),
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
    if (def.keyEnv && !this.env(def.keyEnv)) return false;
    if (def.urlEnv && !this.env(def.urlEnv)) return false;
    return true;
  }

  private disabled(id: string): boolean {
    return this.settings?.().disabled.includes(id) ?? false;
  }

  private usable(id: string): boolean {
    return this.configured(id) && !this.disabled(id);
  }

  /** A variable saved from the settings page wins over the environment. */
  private env(name: string): string | undefined {
    return this.settings?.().env[name] || this.baseEnv[name] || undefined;
  }

  private available(id: string): boolean {
    if (!this.usable(id)) return false;
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
    return env ? (this.env(env) ?? null) : null;
  }

  private url(id: string): string | null {
    const def = this.cfg.providers[id]!;
    if (def.urlEnv) {
      const base = this.env(def.urlEnv);
      return base ? base.replace(/\/$/, '') + (def.urlSuffix ?? '') : null;
    }
    return def.baseUrl ?? null;
  }

  private model(id: string): string | null {
    return this.env(modelEnv(id)) || this.cfg.providers[id]?.model || null;
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

/** GROQ_MODEL, GEMINI_FLASH_LITE_MODEL… */
const modelEnv = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODEL`;

function blank(): State {
  return { minute: [], day: 0, failuresInRow: 0, openUntil: 0, calls: 0, failures: 0, latencyTotal: 0, lastError: null };
}
