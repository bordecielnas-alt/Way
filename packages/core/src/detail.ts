import type { Poi } from '@way/shared';
import { wikipedia } from '@way/providers';
import type { Store } from './store/types.ts';

/** Full POI for the side panel; fetches the Wikipedia summary on first open. */
export async function loadPoiDetail(id: string, store: Store): Promise<Poi | null> {
  const poi = await store.getPoi(id);
  if (!poi) return null;
  if (poi.summary == null && poi.wiki_title && poi.wiki_lang) {
    try {
      const s = await wikipedia.pageSummary(poi.wiki_lang, poi.wiki_title);
      if (s) {
        const patch = { summary: s.extract, summary_lang: poi.wiki_lang, image_url: poi.image_url ?? s.image };
        await store.updatePoi(id, patch);
        Object.assign(poi, patch);
      }
    } catch (e) {
      console.warn(`[detail] summary fetch failed for ${poi.wiki_title}:`, (e as Error).message);
    }
  }
  await store.touchPoi(id);
  return poi;
}
