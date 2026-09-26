import type { Category, Poi, PoiLite } from '@way/shared';

export type KeyStatus = 'pending' | 'done' | 'partial' | 'failed';

export interface KeyRecord {
  status: KeyStatus;
  updatedAt: number; // epoch ms
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
  updatePoi(id: string, patch: Partial<Pick<Poi, 'summary' | 'summary_lang' | 'image_url' | 'sources'>>): Promise<void>;
  touchPoi(id: string): Promise<void>;

  getKeys(keys: string[]): Promise<Map<string, KeyRecord>>;
  setKeys(keys: string[], status: KeyStatus, providers?: string[]): Promise<void>;
  keyStats(): Promise<Record<KeyStatus, number>>;
  poiCount(): Promise<number>;

  getClassCategories(classes: string[]): Promise<Map<string, Category | null>>;
  setClassCategories(map: Map<string, Category | null>): Promise<void>;
}
