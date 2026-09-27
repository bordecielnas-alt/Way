import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { background, interactive, people } from '@way/providers';
import type { ArmiesResponse, PersonHit, PersonJourney } from '@way/shared';

// Lives followed on the map and armies on campaign. History does not change
// much: answers are kept on disk and only checked again after months, so
// following someone costs Wikidata three small queries, once.

/** Journeys and armies are fetched again (in the background) after this, unless set in the Réglages page. */
const DEFAULT_REFRESH_MS = 180 * 86_400_000;
const SEARCH_MS = 30 * 86_400_000;
const SEARCH_KEEP = 2000;
const FAILED_RETRY_MS = 30 * 60_000;

interface Entry<T> { at: number; value: T }
interface CacheFile {
  journeys: Record<string, Entry<PersonJourney | null>>;
  armies: Record<string, Entry<ArmiesResponse>>;
  searches: Record<string, Entry<PersonHit[]>>;
}

export class PeopleService {
  private cache: CacheFile = { journeys: {}, armies: {}, searches: {} };
  private inflight = new Map<string, Promise<unknown>>();
  private failed = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string | null, private refreshMs: () => number = () => DEFAULT_REFRESH_MS) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheFile>;
        this.cache = { journeys: raw.journeys ?? {}, armies: raw.armies ?? {}, searches: raw.searches ?? {} };
      } catch {
        /* corrupt cache: rebuilt on demand */
      }
    }
  }

  async search(text: string): Promise<PersonHit[]> {
    const k = text.trim().toLowerCase();
    const hit = this.cache.searches[k];
    if (hit && Date.now() - hit.at < SEARCH_MS) return hit.value;
    const value = await this.once(`s:${k}`, () => interactive(() => people.searchPeople(text.trim())));
    this.cache.searches[k] = { at: Date.now(), value };
    const keys = Object.keys(this.cache.searches);
    if (keys.length > SEARCH_KEEP) for (const old of keys.slice(0, keys.length - SEARCH_KEEP)) delete this.cache.searches[old];
    this.scheduleSave();
    return value;
  }

  async journey(qid: string): Promise<PersonJourney | null> {
    return this.cached('journeys', qid, () => people.personJourney(qid), true);
  }

  async armies(decade: number): Promise<ArmiesResponse> {
    return this.cached('armies', String(decade), async () => ({ decade, armies: await people.armiesOfDecade(decade) }), false);
  }

  /** Served from disk; an old answer is refreshed in the background and replaced. */
  private async cached<K extends 'journeys' | 'armies', T extends CacheFile[K][string]['value']>(
    kind: K, key: string, fetch: () => Promise<T>, urgent: boolean,
  ): Promise<T> {
    const table = this.cache[kind] as Record<string, Entry<T>>;
    const hit = table[key];
    const run = () => this.once(`${kind}:${key}`, async () => {
      const value = await fetch();
      table[key] = { at: Date.now(), value };
      this.scheduleSave();
      return value;
    });
    if (hit) {
      if (Date.now() - hit.at > this.refreshMs()) background(() => void run().catch(() => undefined));
      return hit.value;
    }
    const until = this.failed.get(`${kind}:${key}`) ?? 0;
    if (until > Date.now()) throw new Error('Wikidata ne répond pas pour le moment.');
    try {
      return await (urgent ? interactive(run) : run());
    } catch (e) {
      this.failed.set(`${kind}:${key}`, Date.now() + FAILED_RETRY_MS);
      throw e;
    }
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = run().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify(this.cache));
      } catch (e) {
        console.warn('[people] could not save cache:', (e as Error).message);
      }
    }, 3000);
    this.saveTimer.unref();
  }
}
