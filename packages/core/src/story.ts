import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  distanceKm, histToAstro, MAX_YEAR, MIN_YEAR, STORY_PHASES, toLite,
  type Poi, type Story, type StoryPerson, type StoryPhase, type StoryResponse, type StoryScenario, type StoryStop,
} from '@way/shared';
import { geocode, people, wikidata, wikipedia, type DatedRow } from '@way/providers';
import { normalize, quoted } from './links.ts';
import { buildPois } from './pipeline.ts';
import type { ProviderRouter } from './router.ts';
import type { Store } from './store/types.ts';

// The story of a subject, beyond the five doors: an AI reads the card's
// article for the places and moments of its story (where the Titanic was
// built, the ports it called at, where it sank), what it led to (the wars
// after the attacks on the World Trade Center), the people who lived it, and
// writes a few walks through it in someone's shoes. Every place and person
// must quote the article; places are found on the map (Wikidata, else the
// geocoders), people must be Wikidata humans; scenarios may only walk
// through the stops that passed. A story is read once, then kept on disk.

/** Bump when the reading changes: stories are read again. */
const STORY_VERSION = 1;
const ARTICLE_CHARS = 20_000;
const MAX_STOPS = 12;
const MAX_PEOPLE = 6;
const MAX_SCENARIOS = 3;
/** Years a Wikidata event's date may differ from the article's. */
const YEAR_SLACK = 3;
const EMPTY_RETRY_MS = 7 * 86_400_000;
const FAILED_RETRY_MS = 30 * 60_000;
/** Cards opened meanwhile wait here, the latest first; older ones are dropped. */
const QUEUE_MAX = 4;

const StopItem = z.object({
  name: z.string().trim().min(2).max(160),
  modern_place: z.string().trim().min(2).max(200),
  year: z.number().int(),
  label: z.string().trim().min(2).max(60),
  phase: z.enum(STORY_PHASES),
  quote: z.string().trim().min(12).max(500),
});
const PersonItem = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(80),
  quote: z.string().trim().min(12).max(500),
});
const ScenarioItem = z.object({
  title: z.string().trim().min(3).max(80),
  premise: z.string().trim().min(10).max(260),
  person: z.string().trim().max(120).nullish(),
  steps: z.array(z.object({ stop: z.string().trim().min(2).max(160), text: z.string().trim().min(5).max(240) })).max(8),
});
export const ExtractedStory = z.object({
  stops: z.array(StopItem.nullable().catch(null)).max(24).catch([]),
  people: z.array(PersonItem.nullable().catch(null)).max(12).catch([]),
  scenarios: z.array(ScenarioItem.nullable().catch(null)).max(6).catch([]),
});
type StopItem = z.infer<typeof StopItem>;
type PersonItem = z.infer<typeof PersonItem>;
type ScenarioItem = z.infer<typeof ScenarioItem>;

const SYSTEM = `You read a Wikipedia article about a historical subject (an event, a ship, a building, a battle, a person...) and lay out its story as places a visitor of an interactive globe can travel to.
Return three lists.
1. stops: the places and moments of the story, in three phases:
   - "before": its origins: where it was conceived, built, founded or prepared, and the events that led to it;
   - "during": the places where it happened or that it went through (ports of departure and of call, the route, the site of the event, where people fled or were rescued);
   - "after": what it led to: later events, wars, trials, inquiries, rescues, burials, reconstructions, memorials.
   For each: name (the place or event as the article names it), modern_place (findable on a map today, followed by its country, e.g. "Southampton, United Kingdom", "Cobh, Ireland", "Lower Manhattan, New York, United States"; for an event, the place where it happened), year (historical: negative before Christ, -44 = 44 BC, no year 0), label (its part in the story, in French, 2 to 6 words, e.g. "Port de départ", "Escale à Cherbourg", "Lieu du naufrage", "Riposte américaine"), phase, quote.
   At most ${MAX_STOPS}, the most telling first; every stop must have a place on a map.
2. people: the people of the story the article names (builders, commanders, victims, survivors, perpetrators, rescuers, witnesses...). For each: name (full name, as in their own Wikipedia article), role (in French, 2 to 8 words, e.g. "Commandant du navire", "Architecte des tours"), quote. At most ${MAX_PEOPLE}.
3. scenarios: up to ${MAX_SCENARIOS} short walks through the story in someone's shoes, for a curious visitor: one of the people above, or a typical person of the time the article describes (a third-class emigrant, a firefighter, a soldier...). For each: title (French, a few words), premise (French, one sentence in the second person: "Vous êtes..."), person (the "name" of one of the people above, or null), steps (2 to 6, in the order of time; each: stop = the "name" of one of the stops above, exactly as you wrote it; text = what this character lives there, in French, one or two sentences, faithful to the article).
Rules, all mandatory:
- Stops and people ONLY from what the article states explicitly; quote = the exact words of the article (copied verbatim, 12 to 300 characters) that state it. Never add knowledge of your own. Fewer items are better than doubtful ones.
- Scenarios are imagined, but must not contradict the article or invent events: only the stops listed.
Answer with a single JSON object: {"stops": [...], "people": [...], "scenarios": [...]}.`;

/** A stop's Wikidata item: an event of the story's year, or a place that already existed then. Pure, for tests. */
export function fitsStory(row: Pick<DatedRow, 'year' | 'prop'>, year: number): boolean {
  const d = histToAstro(row.year) - histToAstro(year);
  return Math.abs(d) <= YEAR_SLACK || (row.prop === 'P571' && d <= 0);
}

/** A person's lifetime is compatible with the story (born before its last moment). Pure, for tests. */
export function livedThen(p: { born: number | null }, lastYear: number): boolean {
  return p.born === null || histToAstro(p.born) <= histToAstro(lastYear);
}

type Link = { qid: string; titles: string[] };
const tokens = (s: string) => normalize(s.replace(/\([^)]*\)/g, ' ')).split(' ').filter(Boolean);

/**
 * Items the article links to under that name, best first: the same title,
 * then a fuller one ("Edward Smith" → "Edward John Smith"), then a shorter
 * one of two words or more. Parentheses are ignored ("Cobh (Irlande)"). Pure, for tests.
 */
export function linkMatches(name: string, links: Link[]): string[] {
  const want = tokens(name);
  if (want.length === 0) return [];
  const key = want.join(' ');
  const score = (title: string) => {
    const t = tokens(title);
    if (t.join(' ') === key) return 0;
    if (want.every((w) => t.includes(w))) return 1;
    if (t.length >= 2 && t.every((w) => want.includes(w))) return 2;
    return 9;
  };
  return links
    .map((l) => ({ qid: l.qid, s: Math.min(...l.titles.map(score)) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.qid);
}

/**
 * Is a stop's Wikidata row the place meant? Close enough to where the
 * geocoders put it, more leniently for an item the article links to and for
 * events (a sea battle is far from the port named). Without a geocoded
 * place, only a linked item, or an event of that very year, is trusted. Pure, for tests.
 */
export function nearEnough(row: Pick<DatedRow, 'lat' | 'lon' | 'prop'>, place: { lat: number; lon: number } | null, linked: boolean): boolean {
  const isPlace = row.prop === 'P571';
  if (!place) return linked || !isPlace;
  return distanceKm(row, place) <= (isPlace ? (linked ? 150 : 60) : (linked ? 2000 : 500));
}

/**
 * Scenarios that only walk through kept stops, steps in the order of time,
 * at least two of them. Pure, for tests.
 */
export function buildScenarios(items: ScenarioItem[], stops: { name: string; year: number }[], persons: { name: string }[]): StoryScenario[] {
  const stopIndex = new Map(stops.map((s, i) => [normalize(s.name), i]));
  const personIndex = new Map(persons.map((p, i) => [normalize(p.name), i]));
  const out: StoryScenario[] = [];
  for (const sc of items) {
    const seen = new Set<number>();
    const steps = sc.steps.flatMap((st) => {
      const i = stopIndex.get(normalize(st.stop));
      if (i === undefined || seen.has(i)) return [];
      seen.add(i);
      return [{ stop: i, text: st.text }];
    }).sort((a, b) => histToAstro(stops[a.stop]!.year) - histToAstro(stops[b.stop]!.year));
    if (steps.length < 2) continue;
    out.push({
      title: sc.title,
      premise: sc.premise,
      steps,
      person: sc.person ? (personIndex.get(normalize(sc.person)) ?? null) : null,
    });
    if (out.length >= MAX_SCENARIOS) break;
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** As kept on disk: stops remember their Wikidata row, so an evicted card can be built again. */
interface StoredStory extends Story { rows: (DatedRow | null)[] }
interface Entry { at: number; v: number; story: StoredStory | null }

export class StoryService {
  private cache: Record<string, Entry> = {};
  private queue: Poi[] = [];
  private reading: string | null = null;
  private failed = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private file: string | null, private router: ProviderRouter) {
    if (file && existsSync(file)) {
      try {
        this.cache = (JSON.parse(readFileSync(file, 'utf8')) as { stories?: Record<string, Entry> }).stories ?? {};
      } catch {
        /* corrupt cache: read again */
      }
    }
  }

  private key = (poi: Poi) => poi.wikidata_qid ?? poi.id;

  /** The story as known now; one never read is queued. */
  async get(poi: Poi): Promise<StoryResponse> {
    const key = this.key(poi);
    const hit = this.cache[key];
    const fresh = hit && hit.v === STORY_VERSION && (hit.story || Date.now() - hit.at < EMPTY_RETRY_MS);
    if (fresh) return { status: hit.story ? 'ready' : 'none', story: hit.story && (await this.resolve(hit.story)) };
    const old = hit?.story ? await this.resolve(hit.story) : null;
    if (!poi.wiki_title) return { status: old ? 'ready' : 'none', story: old };
    if (!this.router.canRun('extract')) return { status: old ? 'ready' : 'no-ai', story: old };
    this.enqueue(poi);
    return { status: old ? 'ready' : 'pending', story: old };
  }

  private enqueue(poi: Poi): void {
    const key = this.key(poi);
    if (this.reading === key || (this.failed.get(key) ?? 0) > Date.now()) return;
    // The card read last comes first: the visitor has moved on from the others.
    this.queue = [poi, ...this.queue.filter((p) => this.key(p) !== key)].slice(0, QUEUE_MAX);
    if (!this.reading) void this.pump();
  }

  /** One story at a time: free AI quotas are small. */
  private async pump(): Promise<void> {
    const poi = this.queue.shift();
    if (!poi) return;
    const key = this.key(poi);
    this.reading = key;
    try {
      const story = await this.read(poi);
      this.cache[key] = { at: Date.now(), v: STORY_VERSION, story };
      this.scheduleSave();
      console.log(`[story] ${poi.title}: ${story ? `${story.stops.length} stops, ${story.people.length} people, ${story.scenarios.length} scenarios` : 'nothing found'}`);
    } catch (e) {
      this.failed.set(key, Date.now() + FAILED_RETRY_MS);
      console.warn(`[story] ${poi.title} failed:`, (e as Error).message);
    } finally {
      this.reading = null;
      void this.pump();
    }
  }

  private async read(poi: Poi): Promise<StoredStory | null> {
    const lang = poi.wiki_lang ?? 'fr';
    const article = await wikipedia.pageText(lang, poi.wiki_title!, ARTICLE_CHARS);
    if (!article) return null;
    const answer = await this.router.completeJson(
      'extract', SYSTEM, `Article « ${article.title} » :\n\n${article.text}`, (v) => ExtractedStory.parse(v), 6000,
    );
    if (!answer) throw new Error('no AI available');
    const ok = <T extends { quote: string }>(x: T | null): x is T => !!x && quoted(article.text, x.quote);
    const fits = (y: number) => y !== 0 && y >= MIN_YEAR && y <= MAX_YEAR;
    const links = (await wikipedia.linkedItems(lang, article.title).catch(() => [])).filter((l) => l.qid !== poi.wikidata_qid);

    // Stops: one per place and moment, found on the map.
    const items = answer.value.stops.filter(ok).filter((s) => fits(s.year));
    const unique = new Map<string, StopItem>();
    for (const s of items) if (!unique.has(normalize(s.name))) unique.set(normalize(s.name), s);
    const located = (await Promise.all([...unique.values()].slice(0, MAX_STOPS).map((s) => this.locate(poi, s, lang, links))))
      .filter((x): x is NonNullable<typeof x> => !!x);
    const order = (p: StoryPhase) => STORY_PHASES.indexOf(p);
    located.sort((a, b) => order(a.stop.phase) - order(b.stop.phase) || histToAstro(a.stop.year) - histToAstro(b.stop.year));
    const stops = located.map((l) => l.stop);
    if (stops.length === 0) return null;

    const lastYear = Math.max(poi.date_end ?? poi.date_start, ...stops.map((s) => s.year));
    const persons = await this.findPeople(answer.value.people.filter(ok), lang, lastYear, poi.wikidata_qid, links);
    const scenarios = buildScenarios(
      answer.value.scenarios.filter((s): s is ScenarioItem => !!s),
      stops,
      persons.map((p) => p.item),
    );
    return {
      stops,
      people: persons.map((p) => p.person),
      scenarios,
      rows: located.map((l) => l.row),
      source: { url: article.url, title: `Wikipédia : ${article.title}`, kind: 'wikipedia' },
      provider: answer.provider,
    };
  }

  /**
   * A stop on the map: its Wikidata item when one fits the story (an event
   * of that year, a place that already existed then, where the geocoders
   * put it), with a card; else the place found by the geocoders, without one.
   * Items the article links to come first: they are the ones it means.
   */
  private async locate(poi: Poi, s: StopItem, lang: string, links: Link[]): Promise<{ stop: StoryStop; row: DatedRow | null } | null> {
    const base = { phase: s.phase, name: s.name, label: cap(s.label), year: s.year };
    const linked = linkMatches(s.name, links).slice(0, 4);
    const searched = (await wikidata.searchItems(s.name, lang, 3).catch(() => [] as string[]))
      .filter((q) => q !== poi.wikidata_qid && !linked.includes(q));
    const qids = [...linked, ...searched];
    const [rows, place] = await Promise.all([
      qids.length ? wikidata.queryDatedByQids(qids, MIN_YEAR, MAX_YEAR + 1).catch(() => []) : Promise.resolve([]),
      this.geocode(s.modern_place, lang),
    ]);
    const row = qids
      .map((q) => rows.find((r) => r.qid === q))
      .find((r): r is DatedRow => !!r && fitsStory(r, s.year) && nearEnough(r, place, linked.includes(r.qid)));
    if (row) {
      const card = await this.cardOf(row);
      return { stop: { ...base, lat: row.lat, lon: row.lon, poi: card && toLite(card) }, row };
    }
    if (!place) return null;
    return { stop: { ...base, lat: Math.round(place.lat * 1e4) / 1e4, lon: Math.round(place.lon * 1e4) / 1e4, poi: null }, row: null };
  }

  /** "Cobh, Ireland" on the map: Nominatim reads it best, Wikidata for the name alone otherwise. */
  private async geocode(modern: string, lang: string): Promise<{ lat: number; lon: number } | null> {
    return (await geocode.nominatimSearch(modern, undefined, 1).catch(() => []))[0]
      ?? (await geocode.wikidataPlaces(modern.split(',')[0]!.trim(), lang, 3).catch(() => []))[0]
      ?? null;
  }

  private async cardOf(row: DatedRow): Promise<Poi | null> {
    await this.store.upsertPois(await buildPois([row], this.store));
    return (await this.store.getPoisByQids([row.qid]))[0] ?? null;
  }

  private async findPeople(items: PersonItem[], lang: string, lastYear: number, self: string | null, links: Link[]) {
    const found = await Promise.all(items.slice(0, MAX_PEOPLE * 2).map(async (item) => {
      const linked = linkMatches(item.name, links).slice(0, 4);
      const searched = await wikidata.searchItems(item.name, lang, 3).catch(() => [] as string[]);
      const qids = [...new Set([...linked, ...searched])].filter((q) => q !== self);
      const hits = await people.peopleByQids(qids).catch(() => []);
      // The article's links first, then search order: the best known namesake is not always the one meant.
      const hit = qids.map((q) => hits.find((h) => h.qid === q)).find((h) => !!h && livedThen(h, lastYear));
      return hit ? { item, person: { qid: hit.qid, name: hit.name, role: cap(item.role), born: hit.born, died: hit.died, image: hit.image } satisfies StoryPerson } : null;
    }));
    const seen = new Set<string>();
    return found.filter((f): f is NonNullable<typeof f> => !!f && !seen.has(f.person.qid) && !!seen.add(f.person.qid)).slice(0, MAX_PEOPLE);
  }

  /** Cards of the stops, built again if the cache evicted them. */
  private async resolve(s: StoredStory): Promise<Story> {
    const qids = s.rows.flatMap((r) => (r ? [r.qid] : []));
    let byQid = new Map((await this.store.getPoisByQids(qids)).map((p) => [p.wikidata_qid, p]));
    const missing = s.rows.filter((r): r is DatedRow => !!r && !byQid.has(r.qid));
    if (missing.length) {
      await this.store.upsertPois(await buildPois(missing, this.store)).catch(() => {});
      byQid = new Map((await this.store.getPoisByQids(qids)).map((p) => [p.wikidata_qid, p]));
    }
    const { rows, ...story } = s;
    return {
      ...story,
      stops: story.stops.map((stop, i) => {
        const p = rows[i] && byQid.get(rows[i]!.qid);
        return { ...stop, poi: p ? toLite(p) : null };
      }),
    };
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify({ stories: this.cache }));
      } catch (e) {
        console.warn('[story] could not save cache:', (e as Error).message);
      }
    }, 2000);
    this.saveTimer.unref();
  }
}
