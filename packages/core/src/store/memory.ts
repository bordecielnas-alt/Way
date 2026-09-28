import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bucketsInRange, GLOBAL_SPACE, parseKey, poiInWindow, toLite, type Category, type Poi, type PoiLite } from '@way/shared';
import type { KeyRecord, KeyStatus, Store, StoredDoors, ViewQuery } from './types.ts';

interface Snapshot {
  pois: Poi[];
  doors?: [string, StoredDoors][];
  keys: [string, KeyRecord][];
  classes: [string, Category | null][];
}

/**
 * In-process store for local development without Docker. Optionally
 * snapshotted to a JSON file so restarts (tsx watch) keep the cache.
 */
export class MemoryStore implements Store {
  private pois = new Map<string, Poi>();
  private byQid = new Map<string, string>();
  private byCell = new Map<string, Set<string>>();
  private keys = new Map<string, KeyRecord>();
  private classes = new Map<string, Category | null>();
  private doors = new Map<string, StoredDoors>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file?: string) {}

  async init(): Promise<void> {
    if (!this.file || !existsSync(this.file)) return;
    const snap = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
    for (const p of snap.pois) this.index(p);
    // Pending keys from a previous run will never complete: drop them.
    this.keys = new Map(snap.keys.filter(([, r]) => r.status !== 'pending'));
    this.classes = new Map(snap.classes);
    this.doors = new Map(snap.doors ?? []);
  }

  async close(): Promise<void> {
    if (this.saveTimer) this.flush();
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  private flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const snap: Snapshot = { pois: [...this.pois.values()], keys: [...this.keys], classes: [...this.classes], doors: [...this.doors] };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(snap));
  }

  private index(p: Poi): void {
    this.pois.set(p.id, p);
    if (p.wikidata_qid) this.byQid.set(p.wikidata_qid, p.id);
    for (const c of p.h3_cells) {
      let s = this.byCell.get(c);
      if (!s) this.byCell.set(c, (s = new Set()));
      s.add(p.id);
    }
  }

  async upsertPois(pois: Poi[]): Promise<void> {
    for (const p of pois) {
      const existingId = p.wikidata_qid ? this.byQid.get(p.wikidata_qid) : undefined;
      const prev = existingId ? this.pois.get(existingId) : undefined;
      if (prev) {
        for (const c of prev.h3_cells) this.byCell.get(c)?.delete(prev.id);
        this.index({ ...p, id: prev.id, summary: prev.summary, summary_lang: prev.summary_lang, view_count: prev.view_count });
      } else this.index(p);
    }
    this.scheduleSave();
  }

  async existingQids(qids: string[]): Promise<Set<string>> {
    return new Set(qids.filter((q) => this.byQid.has(q)));
  }

  async queryView(q: ViewQuery): Promise<PoiLite[]> {
    const out: PoiLite[] = [];
    for (const cell of q.cells) {
      const ids = this.byCell.get(cell);
      if (!ids) continue;
      const hits = [...ids]
        .map((id) => this.pois.get(id)!)
        .filter((p) => poiInWindow(p, q.tStart, q.tEnd))
        .sort((a, b) => b.importance - a.importance)
        .slice(0, q.perCell);
      out.push(...hits.map(toLite));
    }
    return out;
  }

  async getPoi(id: string): Promise<Poi | null> {
    return this.pois.get(id) ?? null;
  }

  async updatePoi(id: string, patch: Partial<Poi>): Promise<void> {
    const p = this.pois.get(id);
    if (p) this.pois.set(id, { ...p, ...patch });
    this.scheduleSave();
  }

  async touchPoi(id: string): Promise<void> {
    const p = this.pois.get(id);
    if (p) p.view_count++;
    this.scheduleSave();
  }

  async getPoisByQids(qids: string[]): Promise<Poi[]> {
    return qids.map((q) => this.byQid.get(q)).filter((id): id is string => !!id).map((id) => this.pois.get(id)!);
  }

  async queryTimeRange(t0: number, t1: number, limit: number): Promise<PoiLite[]> {
    return [...this.pois.values()]
      .filter((p) => poiInWindow(p, t0, t1))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(toLite);
  }

  async getDoors(id: string): Promise<StoredDoors | null> {
    return this.doors.get(id) ?? null;
  }

  async setDoors(id: string, doors: StoredDoors): Promise<void> {
    this.doors.set(id, doors);
    this.scheduleSave();
  }

  async getKeys(keys: string[]): Promise<Map<string, KeyRecord>> {
    const out = new Map<string, KeyRecord>();
    for (const k of keys) {
      const r = this.keys.get(k);
      if (r) out.set(k, r);
    }
    return out;
  }

  async setKeys(keys: string[], status: KeyStatus, providers: string[] = []): Promise<void> {
    const now = Date.now();
    for (const k of keys) this.keys.set(k, { status, updatedAt: now, providers });
    this.scheduleSave();
  }

  async keyStats(): Promise<Record<KeyStatus, number>> {
    const s: Record<KeyStatus, number> = { pending: 0, done: 0, partial: 0, failed: 0 };
    for (const r of this.keys.values()) s[r.status]++;
    return s;
  }

  async poiCount(): Promise<number> {
    return this.pois.size;
  }

  async cacheBytes(): Promise<number> {
    let n = 0;
    for (const p of this.pois.values()) n += JSON.stringify(p).length;
    return n + this.keys.size * 60;
  }

  async evict(count: number, pinImportance: number): Promise<number> {
    const victims = [...this.pois.values()]
      .filter((p) => p.importance < pinImportance)
      .sort((a, b) => a.view_count - b.view_count || a.importance - b.importance)
      .slice(0, Math.max(0, count));
    const spaces = new Set<string>();
    const buckets = new Set<number>();
    for (const p of victims) {
      this.pois.delete(p.id);
      if (p.wikidata_qid) this.byQid.delete(p.wikidata_qid);
      for (const c of p.h3_cells) {
        this.byCell.get(c)?.delete(p.id);
        spaces.add(c);
      }
      bucketsInRange(p.date_start, p.date_end ?? p.date_start).forEach((b) => buckets.add(b));
    }
    for (const k of [...this.keys.keys()]) {
      const { space, bucket } = parseKey(k);
      if (spaces.has(space) || (space === GLOBAL_SPACE && buckets.has(bucket))) this.keys.delete(k);
    }
    if (victims.length) this.scheduleSave();
    return victims.length;
  }

  async getClassCategories(classes: string[]): Promise<Map<string, Category | null>> {
    const out = new Map<string, Category | null>();
    for (const c of classes) if (this.classes.has(c)) out.set(c, this.classes.get(c)!);
    return out;
  }

  async setClassCategories(map: Map<string, Category | null>): Promise<void> {
    for (const [k, v] of map) this.classes.set(k, v);
    this.scheduleSave();
  }
}
