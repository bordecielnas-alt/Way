import {
  bucketStep, CATEGORY_LABELS, CATEGORY_THEME, distanceKm, formatYear, histToAstro, MAX_YEAR, MIN_YEAR, THEME_LABELS, toLite,
  type Category, type PersonScenarioResponse, type Poi, type PoiLite, type ScenarioWalk, type Theme, type WalkStep,
} from '@way/shared';
import { wikidata } from '@way/providers';
import { isDull, spanYears } from './doors.ts';
import { buildPois } from './pipeline.ts';
import type { Store } from './store/types.ts';

// Walks that need no story read by an AI, made of cards: one place across the
// centuries (what happened there and close by, era after era), and the world
// at one moment (a theme per step, far from each other). Each step is then
// written from its card's own article when the visitor gets there.

/** "Here": close in a dense city, wider for empty surroundings (as the doors' "ici, plus tard"). */
const PLACE_KM = 8;
const PLACE_WIDE_KM = 40;
const PLACE_MIN_ROWS = 10;
/** Steps of a place across the centuries, and dated items around it looked at. */
const PLACE_STEPS = 8;
const PLACE_ROWS = 400;
/** Steps of the world at one moment, how far apart, and the longest event that still says "this moment". */
const ERA_STEPS = 6;
const ERA_APART_KM = 700;
const ERA_MAX_SPAN = 20;
/** Cards known looked at for a moment, and items asked of Wikidata when they are too few. */
const ERA_LOOKUP = 800;
const ERA_ROWS = 200;
const ERA_SITELINKS = 8;
/** Themes a moment is told by, in this order unless the visitor shows others (geography says little of a moment, a city founded comes last). */
const ERA_THEMES: Theme[] = ['state', 'war', 'religion', 'trade', 'knowledge', 'culture', 'exploration', 'disaster', 'society', 'settlement'];
const KEEP = 200;
/** Cards that are places (named as such), not events that happened at one. */
const PLACE_CATEGORIES = new Set<Category>(['city', 'place', 'monument', 'fortification', 'religion', 'nature', 'polity']);

/** A card's theme (people and countries tell no single moment). */
function themeOfCard(c: Pick<PoiLite, 'category'>): Theme | null {
  return c.category === 'person' || c.category === 'polity' ? null : CATEGORY_THEME[c.category as Exclude<Category, 'person'>];
}

/**
 * Moments of a place across time: the best known first (a famous building of
 * 1995 says less of a place's past than an old one), each far enough in time
 * from those taken, `first` always; then in the order of time. Pure, for tests.
 */
export function acrossTime<T extends { year: number; weight: number }>(items: T[], n = PLACE_STEPS, first?: T): T[] {
  const weight = (r: T) => r.weight * (r.year >= 1900 ? 0.35 : 1);
  const picked: T[] = first ? [first] : [];
  for (const r of [...items].sort((a, b) => weight(b) - weight(a))) {
    if (picked.length >= n) break;
    const gap = Math.max(20, 2 * bucketStep(r.year));
    if (picked.some((p) => p === r || Math.abs(histToAstro(p.year) - histToAstro(r.year)) < gap)) continue;
    picked.push(r);
  }
  return picked.sort((a, b) => histToAstro(a.year) - histToAstro(b.year));
}

/**
 * The world at one moment: one card per theme, the visitor's themes first,
 * the best known of each, far from those taken; then in the order of a tour
 * starting nearest the visitor. Pure, for tests.
 */
export function aroundTheWorld<T extends Pick<PoiLite, 'id' | 'category' | 'lat' | 'lon' | 'importance'>>(
  cards: T[], from: { lat: number; lon: number }, shown: readonly Theme[] = [], n = ERA_STEPS, apartKm = ERA_APART_KM,
): { card: T; theme: Theme }[] {
  const order = [...ERA_THEMES.filter((t) => shown.includes(t)), ...ERA_THEMES.filter((t) => !shown.includes(t))];
  const best = [...cards].sort((a, b) => b.importance - a.importance);
  const picked: { card: T; theme: Theme }[] = [];
  for (const theme of order) {
    if (picked.length >= n) break;
    const card = best.find((c) => themeOfCard(c) === theme && picked.every((p) => p.card.id !== c.id && distanceKm(p.card, c) >= apartKm));
    if (card) picked.push({ card, theme });
  }
  // A tour: each step the nearest of those left.
  const tour: { card: T; theme: Theme }[] = [];
  let at = from;
  const left = [...picked];
  while (left.length) {
    left.sort((a, b) => distanceKm(at, a.card) - distanceKm(at, b.card));
    const next = left.shift()!;
    tour.push(next);
    at = next.card;
  }
  return tour;
}

/** Years either side of a moment that still say "then": a year in modern times, decades in antiquity. */
export function eraWindow(year: number): [number, number] {
  const w = Math.max(1, Math.round(bucketStep(year) / 2));
  return [Math.max(MIN_YEAR, year - w), Math.min(MAX_YEAR, year + w)];
}

const wikiUrl = (p: Poi) => `https://${p.wiki_lang ?? 'fr'}.wikipedia.org/wiki/${encodeURIComponent((p.wiki_title ?? p.title).replace(/ /g, '_'))}`;

function stepOfCard(p: Poi, label: string): WalkStep {
  return { place: p.title, label, year: p.date_start, when: null, lat: p.lat, lon: p.lon, poi: toLite(p), text: '', cast: [], image: p.image_url ?? null };
}

export class ThreadService {
  private places = new Map<string, Promise<ScenarioWalk | null>>();
  private eras = new Map<string, Promise<ScenarioWalk | null>>();

  constructor(private store: Store) {}

  /** A place across the centuries, from its card: the card's moment and others there, each with its own article. */
  async place(poi: Poi): Promise<PersonScenarioResponse> {
    const walk = await this.once(this.places, poi.id, () => this.readPlace(poi));
    return { status: walk ? 'ready' : 'none', walk };
  }

  /** The world at one moment, a theme per step, starting near the visitor; the themes they show first. */
  async era(year: number, from: { lat: number; lon: number }, shown: Theme[]): Promise<PersonScenarioResponse> {
    const key = `${year}|${shown.join(',')}|${Math.round(from.lat / 10)},${Math.round(from.lon / 10)}`;
    const walk = await this.once(this.eras, key, () => this.readEra(year, from, shown));
    return { status: walk ? 'ready' : 'none', walk };
  }

  /** Asked once while kept; a failure is asked again next time. */
  private once(cache: Map<string, Promise<ScenarioWalk | null>>, key: string, read: () => Promise<ScenarioWalk | null>): Promise<ScenarioWalk | null> {
    let run = cache.get(key);
    if (!run) {
      run = read().catch((e) => {
        cache.delete(key);
        console.warn(`[threads] ${key} failed:`, (e as Error).message);
        return null;
      });
      cache.set(key, run);
      if (cache.size > KEEP) cache.delete(cache.keys().next().value!);
    }
    return run;
  }

  private async readPlace(poi: Poi): Promise<ScenarioWalk | null> {
    const around = (km: number) => wikidata.queryAround(poi.lat, poi.lon, km, MIN_YEAR, MAX_YEAR + 1, PLACE_ROWS);
    let rows = await around(PLACE_KM);
    if (rows.length < PLACE_MIN_ROWS) rows = await around(PLACE_WIDE_KM);
    // Twice as many as needed: some are roads and stations, some have no article.
    const asked = acrossTime(rows.filter((r) => r.qid !== poi.wikidata_qid).map((r) => ({ ...r, weight: r.sitelinks })), PLACE_STEPS * 2);
    await this.store.upsertPois(await buildPois(asked, this.store));
    const cards = (await this.store.getPoisByQids(asked.map((r) => r.qid)))
      .filter((c) => c.id !== poi.id && c.wiki_title && !isDull(c) && themeOfCard(c));
    const item = (c: Poi) => ({ c, year: c.date_start, weight: c.importance });
    const self = item(poi);
    const picked = acrossTime(cards.map(item), PLACE_STEPS, self);
    if (picked.length < 3) return null;
    const first = picked[0]!.year;
    const last = picked.at(-1)!.year;
    // A place is named; an event is where it happened.
    const named = PLACE_CATEGORIES.has(poi.category);
    return {
      id: `place|${poi.id}`,
      title: named ? `${poi.title} à travers les siècles` : `Là où eut lieu « ${poi.title} », à travers les siècles`,
      premise: `Le même lieu d’époque en époque, de ${formatYear(first)} à ${formatYear(last)} : ce qui s’est passé ${named ? `à ${poi.title}` : 'là'} et tout près, chaque étape d’après son propre article.`,
      invented: true,
      thread: 'place',
      hero: null,
      from: null,
      source: { url: wikiUrl(poi), title: `Wikipédia : ${poi.wiki_title ?? poi.title}`, kind: 'wikipedia' },
      steps: picked.map(({ c }) => stepOfCard(c, CATEGORY_LABELS[c.category])),
    };
  }

  private async readEra(year: number, from: { lat: number; lon: number }, shown: Theme[]): Promise<ScenarioWalk | null> {
    const [t0, t1] = eraWindow(year);
    const fits = (p: PoiLite) => !!themeOfCard(p) && !isDull(p) && spanYears(p) <= ERA_MAX_SPAN;
    let cards = (await this.store.queryTimeRange(t0, t1, ERA_LOOKUP)).filter(fits);
    let picked = aroundTheWorld(cards, from, shown);
    // The cache usually knows the era (global searches fill it); else Wikidata's best known items then.
    if (picked.length < ERA_STEPS) {
      const rows = await wikidata.queryGlobal(t0, t1 + 1, ERA_SITELINKS, ERA_ROWS).catch(() => []);
      await this.store.upsertPois(await buildPois(rows, this.store));
      const known = new Set(cards.map((c) => c.id));
      const more = (await this.store.getPoisByQids(rows.map((r) => r.qid))).map(toLite).filter((c) => fits(c) && !known.has(c.id));
      cards = [...cards, ...more];
      picked = aroundTheWorld(cards, from, shown);
    }
    // Only cards with an article: each step is written from it.
    const full = (await Promise.all(picked.map(async (x) => ({ ...x, poi: await this.store.getPoi(x.card.id) }))))
      .filter((x): x is typeof x & { poi: Poi } => !!x.poi?.wiki_title);
    if (full.length < 3) return null;
    const themes = full.map((x) => THEME_LABELS[x.theme].toLowerCase());
    return {
      id: `era|${year}|${full.map((x) => x.poi.id).join(',')}`,
      title: `Le monde vers ${formatYear(year)}`,
      premise: `Autour de ${formatYear(year)}, le même moment vu sous plusieurs angles, d’un bout du monde à l’autre : ${themes.join(', ')}.`,
      invented: true,
      thread: 'era',
      hero: null,
      from: null,
      source: { url: 'https://www.wikidata.org/', title: 'Wikidata', kind: 'wikidata' },
      steps: full.map((x) => stepOfCard(x.poi, THEME_LABELS[x.theme])),
    };
  }
}
