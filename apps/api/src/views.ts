import {
  bucketsInRange, GLOBAL_SPACE, isGlobalSearchRes, makeKey, MAX_YEAR, MIN_YEAR,
  type PoiLite, type ServerMessage, type ViewMessage,
} from '@way/shared';
import { planJobs, type Config, type JobBus, type SearchJob, type Store } from '@way/core';

export type View = Omit<ViewMessage, 'type'>;

const PER_CELL = 14;
/** Background loads followed per session (older ones are forgotten). */
const BACKGROUND_MAX = 8;
/** A zone is enriched again with level 2 after this long (the web keeps growing). */
const ENRICH_EVERY_MS = 30 * 86_400_000;
/** Level-2 enrichments started for one still view (each costs quota). */
const ENRICH_PER_VIEW = 2;

interface Session {
  view: View | null;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  /** Places and periods around the view being loaded, to push once searched. */
  background: { view: View; keys: Set<string> }[];
  send(msg: ServerMessage): void;
}

/**
 * Resolves views into cached POIs and missing search keys, enqueues the
 * missing ones, and pushes refreshed POIs to sockets as keys complete.
 * While the viewer stays still, it also loads what lies around (prefetch)
 * and keeps enriching the view with level 2, in the background.
 */
export class ViewService {
  private sessions = new Set<Session>();

  constructor(
    private store: Store,
    private bus: JobBus,
    private cfg: Config,
    /** Whether level 2 can run at all (an LLM and a search provider configured). */
    private canEnrich: () => boolean = () => false,
    /** The AI level 2 goes to now, named for the visitor. */
    private aiName: () => string | null = () => null,
  ) {
    bus.onKeysDone((keys) => this.onKeysDone(keys));
  }

  keysFor(v: View): string[] {
    const buckets = bucketsInRange(v.tStart, v.tEnd);
    if (isGlobalSearchRes(v.res)) return buckets.map((b) => makeKey(GLOBAL_SPACE, b, v.filter));
    return v.cells.flatMap((c) => buckets.map((b) => makeKey(c, b, v.filter)));
  }

  /** Returns cached POIs now; enqueues searches for missing keys. */
  async resolve(v: View): Promise<{ pois: PoiLite[]; pending: Set<string> }> {
    const keys = this.keysFor(v);
    const records = await this.store.getKeys(keys);
    const now = Date.now();
    const { pendingTimeoutMs, failedRetryMs } = this.cfg.search;
    const missing: string[] = [];
    const pending = new Set<string>();
    for (const k of keys) {
      const r = records.get(k);
      if (!r) missing.push(k);
      // partial: level 1 is cached, level 2 still runs; both count as "in progress".
      else if (r.status === 'pending' || r.status === 'partial') {
        if (now - r.updatedAt <= pendingTimeoutMs) pending.add(k);
        else if (r.status === 'pending') missing.push(k); // abandoned search: run it again
      } else if (r.status === 'failed' && now - r.updatedAt > failedRetryMs) missing.push(k);
    }
    if (missing.length > 0) {
      await this.store.setKeys(missing, 'pending');
      await this.bus.enqueue(planJobs(missing, this.cfg));
      for (const k of missing) pending.add(k);
    }
    void this.prefetchAround(v).catch((e) => console.warn('[views] prefetch failed', (e as Error).message));
    return { pois: await this.queryPois(v), pending };
  }

  /**
   * Guesses where the viewer goes next: the periods just before and after
   * the window, same place. Searched in the background when the queue is idle,
   * so dragging the timeline (or playing it) finds points already there.
   */
  private async prefetchAround(v: View): Promise<void> {
    const width = Math.max(1, v.tEnd - v.tStart);
    const around: View[] = [
      { ...v, tStart: v.tEnd + 1, tEnd: Math.min(MAX_YEAR, v.tEnd + width) },
      { ...v, tStart: Math.max(MIN_YEAR, v.tStart - width), tEnd: v.tStart - 1 },
    ].filter((w) => w.tStart <= w.tEnd);
    const keys = around.flatMap((w) => this.keysFor(w));
    if (!keys.length) return;
    const known = await this.store.getKeys(keys);
    const missing = keys.filter((k) => !known.has(k));
    if (missing.length) await this.bus.prefetch(planJobs(missing, this.cfg));
  }

  /**
   * Level 2 on a view level 1 already covered, in the background: zones are
   * enriched once, then again from time to time. The keys turn `partial`
   * meanwhile, which the viewer sees as an hourglass.
   */
  private async enrich(v: View): Promise<boolean> {
    if (isGlobalSearchRes(v.res) || v.res < this.cfg.level2.minRes || !this.canEnrich()) return false;
    const keys = this.keysFor(v);
    const records = await this.store.getKeys(keys);
    const now = Date.now();
    const due = keys.filter((k) => {
      const r = records.get(k);
      if (!r || r.status !== 'done') return false;
      // Level 2 found no provider to run last time (quota spent): retried like a failure.
      if (r.providers?.includes('degraded')) return now - r.updatedAt > this.cfg.search.failedRetryMs;
      return !r.providers?.includes('web') || now - r.updatedAt > ENRICH_EVERY_MS;
    });
    if (!due.length) return false;
    const jobs = planJobs(due, this.cfg)
      .filter((j): j is Extract<SearchJob, { kind: 'area' }> => j.kind === 'area')
      .slice(0, ENRICH_PER_VIEW)
      .map((j): SearchJob => ({ ...j, kind: 'deep' }));
    if (!jobs.length) return false;
    const started = jobs.flatMap((j) => (j.kind === 'deep' ? j.cells.flatMap((c) => j.buckets.map((b) => makeKey(c, b, j.filter))) : []));
    await this.store.setKeys(started.filter((k) => due.includes(k)), 'partial', ['wikidata']);
    await this.bus.enqueue(jobs);
    return true;
  }

  queryPois(v: View): Promise<PoiLite[]> {
    return this.store.queryView({ res: v.res, cells: v.cells, tStart: v.tStart, tEnd: v.tEnd, perCell: PER_CELL });
  }

  /** Searches still running for the view: level 1 (`pending`) and level 2 (`partial`). */
  private async status(s: Session): Promise<void> {
    const v = s.view;
    if (!v) return;
    const keys = this.keysFor(v);
    const records = await this.store.getKeys(keys);
    if (s.view !== v) return;
    const now = Date.now();
    let pending = 0;
    let ai = 0;
    s.pending = new Set();
    for (const k of keys) {
      const r = records.get(k);
      if (!r || now - r.updatedAt > this.cfg.search.pendingTimeoutMs) continue;
      if (r.status === 'pending') pending++;
      else if (r.status === 'partial') ai++;
      else continue;
      s.pending.add(k);
    }
    s.send({ type: 'status', pending, ai, model: ai ? this.aiName() : null });
  }

  openSession(send: (msg: ServerMessage) => void): {
    setView(v: View): Promise<void>;
    prefetch(v: View, ring: number): Promise<void>;
    close(): void;
  } {
    const s: Session = { view: null, pending: new Set(), timer: null, background: [], send };
    this.sessions.add(s);
    return {
      setView: async (v) => {
        s.view = v;
        // A new view: what was loading around the old one no longer matters to this viewer.
        s.background = [];
        const { pois } = await this.resolve(v);
        if (s.view !== v) return; // superseded while resolving
        send({ type: 'pois', pois });
        await this.status(s);
      },
      prefetch: async (v, ring) => {
        if (ring === 0) {
          if (await this.enrich(v)) await this.status(s);
          return;
        }
        const keys = this.keysFor(v);
        const known = await this.store.getKeys(keys);
        const missing = keys.filter((k) => !known.has(k));
        if (missing.length) {
          s.background.push({ view: v, keys: new Set(missing) });
          if (s.background.length > BACKGROUND_MAX) s.background.shift();
          await this.bus.prefetch(planJobs(missing, this.cfg));
        }
        const pois = await this.queryPois(v);
        if (pois.length) send({ type: 'pois', pois, background: true });
      },
      close: () => {
        if (s.timer) clearTimeout(s.timer);
        this.sessions.delete(s);
      },
    };
  }

  private onKeysDone(keys: string[]): void {
    for (const s of this.sessions) {
      // Points found around the view: pushed as they come, kept by the viewer for later.
      for (const b of s.background) {
        let hit = false;
        for (const k of keys) if (b.keys.delete(k)) hit = true;
        if (hit) {
          void this.queryPois(b.view)
            .then((pois) => pois.length && s.send({ type: 'pois', pois, background: true }))
            .catch((e) => console.error('[views] background refresh failed', e));
        }
      }
      s.background = s.background.filter((b) => b.keys.size > 0);

      let hit = false;
      for (const k of keys) if (s.pending.has(k)) hit = true;
      if (!hit || s.timer) continue;
      // Coalesce bursts of completions into one refresh.
      s.timer = setTimeout(async () => {
        s.timer = null;
        if (!s.view) return;
        try {
          s.send({ type: 'pois', pois: await this.queryPois(s.view) });
          await this.status(s);
        } catch (e) {
          console.error('[views] refresh failed', e);
        }
      }, 300);
    }
  }
}
