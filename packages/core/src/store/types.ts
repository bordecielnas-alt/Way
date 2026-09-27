import type { Category, DoorKind, Poi, PoiLite } from '@way/shared';

export type KeyStatus = 'pending' | 'done' | 'partial' | 'failed';

export interface KeyRecord {
  status: KeyStatus;
  updatedAt: number; // epoch ms
}

/** Doors cached on a POI (`related` column): destinations by id, and kinds searched without result. */
export interface StoredDoors {
  v: number;
  /** "Meanwhile" span limit in force when chosen. */
  span?: number;
  doors: { kind: DoorKind; title: string; hint: string; poi_id: string }[];
  empty: DoorKind[];
}

export interface ViewQuery {
  res: number;
  cells: string[];
  tStart: number;
  tEnd: number;
  perCell: number;
}

/** Persistent cache of POIs and search keys (brief §6). */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  /** Insert or update by wikidata_qid; existing ids, summaries and view counts are kept. */
  upsertPois(pois: Poi[]): Promise<void>;
  existingQids(qids: string[]): Promise<Set<string>>;
  /** Top POIs by importance per cell, whose dates intersect the window. */
  queryView(q: ViewQuery): Promise<PoiLite[]>;
  getPoi(id: string): Promise<Poi | null>;
  updatePoi(id: string, patch: Partial<Pick<Poi, 'summary' | 'summary_lang' | 'image_url' | 'sources' | 'tags'>>): Promise<void>;
  touchPoi(id: string): Promise<void>;
  getPoisByQids(qids: string[]): Promise<Poi[]>;
  /** Most important POIs whose dates intersect [t0, t1]. */
  queryTimeRange(t0: number, t1: number, limit: number): Promise<PoiLite[]>;
  getDoors(id: string): Promise<StoredDoors | null>;
  setDoors(id: string, doors: StoredDoors): Promise<void>;

  getKeys(keys: string[]): Promise<Map<string, KeyRecord>>;
  setKeys(keys: string[], status: KeyStatus, providers?: string[]): Promise<void>;
  keyStats(): Promise<Record<KeyStatus, number>>;
  poiCount(): Promise<number>;
  /** Approximate size of the cached data, in bytes (brief §6.4). */
  cacheBytes(): Promise<number>;
  /**
   * Deletes up to `count` POIs, least viewed and longest unseen first, never
   * those at or above `pinImportance`. Search keys that found them are
   * forgotten so the area can be searched again. Returns the number removed.
   */
  evict(count: number, pinImportance: number): Promise<number>;

  getClassCategories(classes: string[]): Promise<Map<string, Category | null>>;
  setClassCategories(map: Map<string, Category | null>): Promise<void>;
}
