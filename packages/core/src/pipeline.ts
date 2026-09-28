import { randomUUID } from 'node:crypto';
import {
  bucketEnd, cellCenter, cellsForPoint, GLOBAL_SPACE, makeKey, parseKey, Poi, cellRadiusKm,
  roleTags, type Category, type DatePrecisionName,
} from '@way/shared';
import { wikidata, wikipedia, type DatedRow } from '@way/providers';
import { cellToParent, getResolution } from 'h3-js';
import { categoryFor, classifyClasses, personRoles } from './categories.ts';
import type { Config } from './config.ts';
import { runDeepJob, type DeepJob } from './level2.ts';
import type { ProviderRouter } from './router.ts';
import type { Store } from './store/types.ts';

export type SearchJob =
  | { kind: 'global'; buckets: number[]; filter: string }
  /** Fine view: one radius query around `area` (an ancestor cell) fills all `cells`. */
  | { kind: 'area'; area: string; cells: string[]; buckets: number[]; filter: string }
  /** Level 2 (web + LLM) for an area level 1 left poor. */
  | DeepJob;

/** Fine cells are searched in groups sharing an ancestor: 2 levels up for close views, 1 for regions (keeps radius queries cheap). */
const areaLevels = (res: number) => (res >= 6 ? 2 : 1);

export interface JobResult {
  keys: string[];
  found: number;
  providers: string[];
  /** Level 2 to run next, in the background. */
  followUp?: SearchJob;
}

export function jobKeys(job: SearchJob): string[] {
  if (job.kind === 'global') return job.buckets.map((b) => makeKey(GLOBAL_SPACE, b, job.filter));
  return job.cells.flatMap((c) => job.buckets.map((b) => makeKey(c, b, job.filter)));
}

/** Group missing keys into as few provider queries as reasonable. */
export function planJobs(keys: string[], cfg: Config): SearchJob[] {
  const groups = new Map<string, number[]>();
  for (const k of keys) {
    const { space, bucket, filter } = parseKey(k);
    const g = `${space}|${filter}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(bucket);
  }
  const jobs: SearchJob[] = [];
  const areas = new Map<string, Extract<SearchJob, { kind: 'area' }>>();
  for (const [g, buckets] of groups) {
    const [space, filter] = g.split('|') as [string, string];
    buckets.sort((a, b) => a - b);
    if (space !== GLOBAL_SPACE) {
      // Neighboring cells share one radius query around their common ancestor.
      const area = cellToParent(space, Math.max(0, getResolution(space) - areaLevels(getResolution(space))));
      const id = `${area}|${filter}`;
      let job = areas.get(id);
      if (!job) {
        job = { kind: 'area', area, cells: [], buckets: [], filter };
        areas.set(id, job);
        jobs.push(job);
      }
      job.cells.push(space);
      job.buckets = [...new Set([...job.buckets, ...buckets])].sort((a, b) => a - b);
      continue;
    }
    // Global queries are expensive per year of span: merge only adjacent small buckets.
    let run: number[] = [];
    for (const b of buckets) {
      const first = run[0];
      const contiguous = run.length > 0 && bucketEnd(run[run.length - 1]!) === b;
      if (first !== undefined && contiguous && bucketEnd(b) - first <= cfg.search.globalMaxSpan) run.push(b);
      else {
        if (run.length) jobs.push({ kind: 'global', buckets: run, filter });
        run = [b];
      }
    }
    if (run.length) jobs.push({ kind: 'global', buckets: run, filter });
  }
  return jobs;
}

function precisionName(p: number): DatePrecisionName {
  if (p >= 9) return 'exact_year';
  if (p === 8) return 'decade';
  if (p === 7) return 'century';
  if (p === 6) return 'millennium';
  return 'approximate';
}

/**
 * Category nudges (brief §6.3): the globe view is about empires and major
 * events; unclassified places rarely matter from far away. Mirrored in
 * migrations/002_importance.sql for POIs cached before.
 */
export const CATEGORY_WEIGHT: Partial<Record<Category, number>> = {
  polity: 0.08, battle: 0.04, disaster: 0.04, event: 0.03, city: 0.02, place: -0.1,
};

/** Importance from Wikipedia language coverage (sitelinks), log-scaled to 0..1, nudged by category. */
export function importanceFor(sl: number, category: Category): number {
  const base = Math.log1p(sl) / Math.log1p(300);
  return Math.min(1, Math.max(0, base + (CATEGORY_WEIGHT[category] ?? 0)));
}

/** Turn dated Wikidata rows into validated POIs (skips entities already cached). */
export async function buildPois(rows: DatedRow[], store: Store): Promise<Poi[]> {
  const existing = await store.existingQids(rows.map((r) => r.qid));
  const fresh = rows.filter((r) => !existing.has(r.qid));
  if (fresh.length === 0) return [];
  const info = await wikidata.queryEntityInfo(fresh.map((r) => r.qid));
  const classMap = await classifyClasses([...info.values()].flatMap((i) => i.classes), store);

  const pois: Poi[] = [];
  for (const r of fresh) {
    const e = info.get(r.qid);
    if (!e || !e.label) continue;
    // Rigor: no Wikipedia article, no summary and no readable source -> skip.
    const wikiLang = e.frTitle ? 'fr' : e.enTitle ? 'en' : null;
    const wikiTitle = e.frTitle ?? e.enTitle;
    if (!wikiLang || !wikiTitle) continue;
    const end = e.endYear != null && e.endYear > r.year && e.endYear - r.year < 3000 ? e.endYear : null;
    const category = categoryFor(e.classes, classMap, r.prop);
    const candidate = {
      id: randomUUID(),
      title: e.label.charAt(0).toUpperCase() + e.label.slice(1),
      summary: null,
      summary_lang: null,
      description: e.description,
      category,
      tags: [],
      date_start: r.year,
      date_end: end,
      date_precision: precisionName(r.precision),
      lat: r.lat,
      lon: r.lon,
      geo_precision: 'exact',
      h3_cells: cellsForPoint(r.lat, r.lon),
      importance: importanceFor(r.sitelinks, category),
      confidence: 'verified',
      provenance: 'wikidata',
      sources: [
        { url: wikipedia.articleUrl(wikiLang, wikiTitle), title: `Wikipédia (${wikiLang}) — ${wikiTitle}`, kind: 'wikipedia' },
        { url: `https://www.wikidata.org/wiki/${r.qid}`, title: `Wikidata — ${r.qid}`, kind: 'wikidata' },
      ],
      image_url: e.image,
      wikidata_qid: r.qid,
      wiki_title: wikiTitle,
      wiki_lang: wikiLang,
      view_count: 0,
    };
    const parsed = Poi.safeParse(candidate);
    if (parsed.success) pois.push(parsed.data);
    else console.warn(`[pipeline] invalid POI ${r.qid}:`, parsed.error.issues[0]?.message);
  }
  // People cross themes: a king belongs to the state, a saint to religion.
  const people = pois.filter((p) => p.category === 'person' && p.wikidata_qid);
  try {
    const roles = await personRoles(people.map((p) => p.wikidata_qid!));
    for (const p of people) p.tags = roleTags(roles.get(p.wikidata_qid!) ?? []);
  } catch (e) {
    console.warn('[pipeline] roles lookup failed:', (e as Error).message);
  }
  return pois;
}

/**
 * Run one search job and cache the results: level 1 (Wikidata + Wikipedia
 * GeoSearch), or level 2 for a `deep` job. A poor level-1 area comes back
 * with a level-2 follow-up; its keys stay `partial` until then.
 */
export async function runSearchJob(job: SearchJob, store: Store, cfg: Config, router?: ProviderRouter): Promise<JobResult> {
  const keys = jobKeys(job);
  if (job.kind === 'deep') {
    const r = router ? await runDeepJob(job, store, router) : { found: 0, provider: null };
    const providers = r.provider ? ['web', r.provider] : ['degraded'];
    await store.setKeys(keys, 'done', providers);
    return { keys, found: r.found, providers };
  }
  const t0 = job.buckets[0]!;
  const t1 = bucketEnd(job.buckets[job.buckets.length - 1]!);
  const providers = ['wikidata'];
  let rows: DatedRow[];

  if (job.kind === 'global') {
    rows = await wikidata.queryGlobal(t0, t1, cfg.search.globalMinSitelinks, cfg.search.globalLimit);
  } else {
    const { lat, lon } = cellCenter(job.area);
    const radiusKm = cellRadiusKm(getResolution(job.area));
    rows = await wikidata.queryAround(lat, lon, radiusKm, t0, t1, cfg.search.cellLimit);
    // Close-up views: Wikipedia GeoSearch catches articles Wikidata's radius query missed.
    if (getResolution(job.cells[0]!) >= 6) {
      providers.push('wikipedia');
      const hits = await wikipedia.geosearch('fr', lat, lon, Math.min(10, radiusKm) * 1000, 200);
      const seen = new Set(rows.map((r) => r.qid));
      const extra = [...new Set(hits.map((h) => h.qid).filter((q): q is string => !!q && !seen.has(q)))];
      rows.push(...(await wikidata.queryDatedByQids(extra, t0, t1)));
    }
  }

  // Consistency check: date must fall in the requested range (1-year slack for BC numbering).
  rows = rows.filter((r) => r.year >= t0 - 1 && r.year < t1 + 1);
  const pois = await buildPois(rows, store);
  await store.upsertPois(pois);

  if (job.kind === 'area' && router && (await isPoor(job, t0, t1 - 1, store, cfg, router))) {
    await store.setKeys(keys, 'partial', providers);
    return { keys, found: pois.length, providers, followUp: { ...job, kind: 'deep' } };
  }
  await store.setKeys(keys, 'done', providers);
  return { keys, found: pois.length, providers };
}

async function isPoor(
  job: Extract<SearchJob, { kind: 'area' }>, t0: number, t1: number, store: Store, cfg: Config, router: ProviderRouter,
): Promise<boolean> {
  const res = getResolution(job.cells[0]!);
  if (res < cfg.level2.minRes || !router.hasProvider('extract')) return false;
  const known = await store.queryView({ res, cells: job.cells, tStart: t0, tEnd: t1, perCell: cfg.level2.minPois });
  return known.length < cfg.level2.minPois;
}
