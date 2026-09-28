import { randomUUID } from 'node:crypto';
import { getResolution, gridDisk, latLngToCell } from 'h3-js';
import { z } from 'zod';
import {
  bucketEnd, cellCenter, cellRadiusKm, cellsForPoint, distanceKm, formatCentury, formatYear, Category, DatePrecision,
  Poi, type Source,
} from '@way/shared';
import { geocode, type Place, type SearchHit } from '@way/providers';
import type { ProviderRouter } from './router.ts';
import type { Store } from './store/types.ts';

// Level 2 (brief §5.5, §7): for areas level 1 left poor, search the web,
// have an LLM extract dated facts from the sources, then check everything
// the LLM says: source citations, dates, and places geocoded independently.

/** Level-2 job: same area and time buckets as the level-1 job that came back poor. */
export interface DeepJob { kind: 'deep'; area: string; cells: string[]; buckets: number[]; filter: string }

/** LLM importance is an estimate: capped below well-documented entities (brief §6.3). */
const MAX_WEB_IMPORTANCE = 0.35;
const MAX_EVENTS = 8;

const Extracted = z.object({
  events: z
    .array(
      z.object({
        title: z.string().trim().min(2).max(160),
        summary: z.string().trim().min(40).max(1500),
        category: Category.catch('event'),
        place_name: z.string().trim().min(2).max(200),
        year_start: z.number().int(),
        year_end: z.number().int().nullish(),
        date_precision: DatePrecision.catch('approximate'),
        sources: z.array(z.number().int().positive()).min(1),
        sources_disagree: z.boolean().optional(),
        importance: z.number().min(0).max(1).optional(),
      }),
    )
    .max(20),
});
type Extracted = z.infer<typeof Extracted>['events'][number];

const SYSTEM = `You extract historical facts for an encyclopedic history globe.
Rules, all mandatory:
- Use ONLY facts explicitly stated in the numbered sources. Never add knowledge of your own, never extrapolate.
- Keep only events, foundations, constructions, discoveries or notable places that are dated and located inside the requested region AND period.
- If nothing qualifies, answer {"events": []}. An empty answer is better than a doubtful one.
- Years are historical years: negative before Christ (-44 = 44 BC), no year 0.
- place_name: the most precise place where it happened, as a modern name findable on a map, followed by the country (e.g. "Arles, France"). Never give coordinates.
- summary: 3 to 5 sentences in French, neutral and factual, reworded (no long quotes).
- title: short French title.
- sources: the numbers of the sources that state the fact.
- sources_disagree: true if the sources contradict each other on this fact.
- importance: 0 to 1, historical significance at world scale (a local event is below 0.2).
- category: one of battle, fortification, city, polity, monument, religion, person, event, discovery, exploration, disaster, trade, art, science, nature, place.
- date_precision: one of exact_year, decade, century, millennium, approximate.
Answer with a single JSON object: {"events": [...]}, at most ${MAX_EVENTS} events.`;

function periodLabel(t0: number, t1: number): string {
  if (t1 - t0 >= 100) return t0 === t1 ? formatCentury(t0) : `${formatCentury(t0)} – ${formatCentury(t1)}`;
  return t0 === t1 ? formatYear(t0) : `${formatYear(t0)} – ${formatYear(t1)}`;
}

/** Accent- and case-insensitive word overlap, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

const placeNames = new Map<string, string | null>();

/** "Arles, France": what the area is called today, for search queries. */
async function areaName(area: string): Promise<string | null> {
  if (placeNames.has(area)) return placeNames.get(area)!;
  const { lat, lon } = cellCenter(area);
  const res = getResolution(area);
  const zoom = res >= 6 ? 10 : res === 5 ? 8 : res === 4 ? 6 : 5;
  const name = await geocode.nominatimReverse(lat, lon, zoom).catch(() => null);
  placeNames.set(area, name);
  return name;
}

/** Geocodes an LLM place name, keeping only a match inside the searched area (or next to it). */
async function locate(name: string, center: { lat: number; lon: number }, maxKm: number): Promise<Place | null> {
  const near = (p: Place) => distanceKm(center, p) <= maxKm;
  const variants = [...new Set([name, name.split(',')[0]!.trim()])];
  for (const v of variants) {
    const hit = (await geocode.wikidataPlaces(v).catch(() => [])).find(near);
    if (hit) return hit;
  }
  const d = maxKm / 111;
  const box = { west: center.lon - d, east: center.lon + d, south: center.lat - d, north: center.lat + d };
  return (await geocode.nominatimSearch(name, box).catch(() => [])).find(near) ?? null;
}

export interface DeepResult { found: number; provider: string | null }

export async function runDeepJob(job: DeepJob, store: Store, router: ProviderRouter): Promise<DeepResult> {
  const t0 = job.buckets[0]!;
  const t1 = bucketEnd(job.buckets[job.buckets.length - 1]!) - 1;
  const center = cellCenter(job.area);
  const radiusKm = cellRadiusKm(getResolution(job.area));
  const place = await areaName(job.area);
  if (!place) return { found: 0, provider: null };

  const hits = await router.search(`histoire ${place} ${periodLabel(t0, t1)}`);
  if (hits.length === 0) return { found: 0, provider: null };

  const user = [
    `Région : ${place} (environ ${Math.round(radiusKm)} km autour de ce point)`,
    `Période : de ${formatYear(t0)} à ${formatYear(t1)} (années ${t0} à ${t1})`,
    '',
    'Sources :',
    ...hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.text}\n`),
  ].join('\n');
  const answer = await router.completeJson('extract', SYSTEM, user, (v) => Extracted.parse(v).events);
  if (!answer) return { found: 0, provider: null }; // degraded mode: no LLM available

  const pois: Poi[] = [];
  for (const ev of answer.value.slice(0, MAX_EVENTS)) {
    const poi = await validate(ev, hits, { t0, t1, center, radiusKm }, store, pois);
    if (poi) pois.push(poi);
  }
  await store.upsertPois(pois);
  return { found: pois.length, provider: answer.provider };
}

/** Guardrails of brief §7: citations, date range, independent geocoding, deduplication. */
async function validate(
  ev: Extracted,
  hits: SearchHit[],
  ctx: { t0: number; t1: number; center: { lat: number; lon: number }; radiusKm: number },
  store: Store,
  batch: Poi[],
): Promise<Poi | null> {
  const cited = [...new Set(ev.sources)].map((n) => hits[n - 1]).filter((h): h is SearchHit => !!h);
  if (cited.length === 0) return null; // every fact needs a real source
  if (ev.year_start === 0 || ev.year_start < ctx.t0 - 1 || ev.year_start > ctx.t1 + 1) return null;
  const end = ev.year_end != null && ev.year_end > ev.year_start ? ev.year_end : null;

  const at = await locate(ev.place_name, ctx.center, ctx.radiusKm * 1.8);
  if (!at) return null;

  // Duplicate of a known POI (same place, same time, similar title), or of this batch?
  const cells = gridDisk(latLngToCell(at.lat, at.lon, 5), 1);
  const known = await store.queryView({ res: 5, cells, tStart: ev.year_start - 10, tEnd: ev.year_start + 10, perCell: 200 });
  const dup = [...known, ...batch].some((p) => distanceKm(p, at) <= 10 && titleSimilarity(p.title, ev.title) >= 0.5);
  if (dup) return null;

  const isWiki = (h: SearchHit) => /(^|\.)wikipedia\.org$/.test(new URL(h.url).hostname);
  const sources: Source[] = cited.map((h) => ({ url: h.url, title: h.title, kind: isWiki(h) ? 'wikipedia' : 'web' }));
  // Recoupement (§7.4): confirmed by Wikipedia -> verified; contradictions -> disputed.
  const confidence = ev.sources_disagree ? 'disputed' : cited.some(isWiki) ? 'verified' : 'web_single_source';

  const parsed = Poi.safeParse({
    id: randomUUID(),
    title: ev.title.charAt(0).toUpperCase() + ev.title.slice(1),
    summary: ev.summary,
    summary_lang: 'fr',
    description: null,
    category: ev.category,
    tags: ['level2'],
    date_start: ev.year_start,
    date_end: end,
    date_precision: ev.date_precision,
    lat: at.lat,
    lon: at.lon,
    geo_precision: at.source === 'wikidata' ? 'exact' : 'city',
    h3_cells: cellsForPoint(at.lat, at.lon),
    importance: Math.min(MAX_WEB_IMPORTANCE, ev.importance ?? 0.15),
    confidence,
    provenance: 'web_ai',
    sources,
    image_url: null,
    wikidata_qid: null,
    wiki_title: null,
    wiki_lang: null,
    view_count: 0,
  });
  return parsed.success ? parsed.data : null;
}
