import { z } from 'zod';
import type { Poi } from '@way/shared';
import { wikipedia } from '@way/providers';
import type { ProviderRouter } from './router.ts';
import type { Store } from './store/types.ts';

/** Tag of summaries translated from English by an LLM (the card says so). */
export const AI_TRANSLATED = 'summary:ai-translated';

const translating = new Set<string>();

const SYSTEM = `You translate encyclopedia summaries into French.
Translate faithfully: add nothing, remove nothing important, keep names, dates and figures exact.
Keep a neutral encyclopedic tone. Answer with a single JSON object: {"fr": "..."}.`;

/**
 * Full POI for the side panel; fetches the Wikipedia summary on first open.
 * `touch: false` for prefetches, which are not real visits.
 */
export async function loadPoiDetail(
  id: string, store: Store, { touch = true, router }: { touch?: boolean; router?: ProviderRouter } = {},
): Promise<Poi | null> {
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
  // English-only article: translate in the background, the next opening shows French.
  if (router && poi.summary && poi.summary_lang === 'en' && !translating.has(id) && router.canRun('write')) {
    translating.add(id);
    void translate(poi, store, router).finally(() => translating.delete(id));
  }
  if (touch) await store.touchPoi(id);
  return poi;
}

async function translate(poi: Poi, store: Store, router: ProviderRouter): Promise<void> {
  const r = await router.completeJson('write', SYSTEM, poi.summary!, (v) => z.object({ fr: z.string().min(20) }).parse(v).fr);
  if (!r) return;
  await store.updatePoi(poi.id, { summary: r.value, summary_lang: 'fr', tags: [...new Set([...poi.tags, AI_TRANSLATED])] });
}
