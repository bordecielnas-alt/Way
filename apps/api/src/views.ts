import {
  bucketsInRange, GLOBAL_SPACE, isGlobalSearchRes, makeKey,
  type PoiLite, type ServerMessage, type ViewMessage,
} from '@way/shared';
import { planJobs, type Config, type JobBus, type Store } from '@way/core';

export type View = Omit<ViewMessage, 'type'>;

const PER_CELL = 14;

interface Session {
  view: View | null;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  send(msg: ServerMessage): void;
}

/**
 * Resolves views into cached POIs and missing search keys, enqueues the
 * missing ones, and pushes refreshed POIs to sockets as keys complete.
 */
export class ViewService {
  private sessions = new Set<Session>();

  constructor(private store: Store, private bus: JobBus, private cfg: Config) {
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
      else if (r.status === 'pending') {
        if (now - r.updatedAt > pendingTimeoutMs) missing.push(k);
        else pending.add(k);
      } else if (r.status === 'failed' && now - r.updatedAt > failedRetryMs) missing.push(k);
    }
    if (missing.length > 0) {
      await this.store.setKeys(missing, 'pending');
      await this.bus.enqueue(planJobs(missing, this.cfg));
      for (const k of missing) pending.add(k);
    }
    return { pois: await this.queryPois(v), pending };
  }

  queryPois(v: View): Promise<PoiLite[]> {
    return this.store.queryView({ res: v.res, cells: v.cells, tStart: v.tStart, tEnd: v.tEnd, perCell: PER_CELL });
  }

  openSession(send: (msg: ServerMessage) => void): { setView(v: View): Promise<void>; close(): void } {
    const s: Session = { view: null, pending: new Set(), timer: null, send };
    this.sessions.add(s);
    return {
      setView: async (v) => {
        s.view = v;
        const { pois, pending } = await this.resolve(v);
        if (s.view !== v) return; // superseded while resolving
        s.pending = pending;
        send({ type: 'pois', pois });
        send({ type: 'status', pending: pending.size });
      },
      close: () => {
        if (s.timer) clearTimeout(s.timer);
        this.sessions.delete(s);
      },
    };
  }

  private onKeysDone(keys: string[]): void {
    for (const s of this.sessions) {
      let hit = false;
      for (const k of keys) if (s.pending.delete(k)) hit = true;
      if (!hit || s.timer) continue;
      // Coalesce bursts of completions into one refresh.
      s.timer = setTimeout(async () => {
        s.timer = null;
        if (!s.view) return;
        try {
          s.send({ type: 'pois', pois: await this.queryPois(s.view) });
          s.send({ type: 'status', pending: s.pending.size });
        } catch (e) {
          console.error('[views] refresh failed', e);
        }
      }, 300);
    }
  }
}
