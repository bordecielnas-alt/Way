import { MAX_YEAR, MIN_YEAR, toLite, type PoiLite } from '@way/shared';
import { wikidata } from '@way/providers';
import { buildPois } from './pipeline.ts';
import type { Store } from './store/types.ts';

// The search bar's cards: events, places and works by name, as Wikidata
// knows them. Only dated and placed items become cards (the globe needs
// both); they are kept like any other point.

const SEARCH_LIMIT = 10;

/** Cards whose name matches, best match first. */
export async function findCards(q: string, store: Store, limit = 6): Promise<PoiLite[]> {
  const qids = await wikidata.searchItems(q, 'fr', SEARCH_LIMIT);
  if (qids.length === 0) return [];
  const rows = await wikidata.queryDatedByQids(qids, MIN_YEAR, MAX_YEAR + 1);
  if (rows.length) await store.upsertPois(await buildPois(rows, store));
  const byQid = new Map((await store.getPoisByQids(rows.map((r) => r.qid))).map((p) => [p.wikidata_qid, p]));
  return qids.flatMap((q) => {
    const p = byQid.get(q);
    // People follow their own lives on the map: they are found by the people search.
    return p && p.category !== 'person' ? [toLite(p)] : [];
  }).slice(0, limit);
}
