import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  distanceKm, histToAstro, LENSES, MAX_YEAR, MIN_YEAR, STORY_PHASES, THEME_LABELS, THEMES, toLite,
  type Poi, type ScenarioContext, type ScenariosResponse, type Story, type StoryPerson, type StoryPhase, type StoryResponse,
  type StoryScenario, type StoryStop,
} from '@way/shared';
import { geocode, people, wikidata, wikipedia, type DatedRow } from '@way/providers';
import { grounded, normalize } from './links.ts';
import { buildPois } from './pipeline.ts';
import type { ProviderRouter } from './router.ts';
import type { Store } from './store/types.ts';

// The story of a subject, beyond the five doors: an AI reads the card's
// article for the places and moments of its story (where the Titanic was
// built, the ports it called at, where it sank), what it led to (the wars
// after the attacks on the World Trade Center) and the people who lived it.
// Every place and person must quote the article; places are found on the map
// (Wikidata, else the geocoders), people must be Wikidata humans.
// Scenarios come in a second reading, written for the visitor's lens and
// themes and the cards that led them here: two follow real people, the last
// an invented character; they may only walk through the stops that passed,
// with the people present at each step. Both are read once, then kept on disk.

/** Bump when the reading changes: stories are read again. */
const STORY_VERSION = 9;
const SCENARIOS_VERSION = 8;
const ARTICLE_CHARS = 20_000;
const SCENARIO_ARTICLE_CHARS = 12_000;
const MAX_STOPS = 12;
const MAX_PEOPLE = 6;
const MAX_SCENARIOS = 3;
/** Real people followed by scenarios; the rest are invented characters. */
const REAL_SCENARIOS = 2;
const MAX_CAST = 4;
/** Scenarios kept on disk (one set per card and way of looking). */
const SCENARIOS_KEEP = 2000;
/** Years a Wikidata event's date may differ from the article's. */
const YEAR_SLACK = 3;
const EMPTY_RETRY_MS = 7 * 86_400_000;
const FAILED_RETRY_MS = 30 * 60_000;
/** Readings asked meanwhile wait here, the latest first; older ones are dropped. */
const QUEUE_MAX = 6;

const StopItem = z.object({
  name: z.string().trim().min(2).max(160),
  modern_place: z.string().trim().min(2).max(200),
  year: z.number().int(),
  label: z.string().trim().min(2).max(60),
  phase: z.enum(STORY_PHASES),
  article: z.string().trim().max(160).nullish(),
  at_subject: z.boolean().catch(false),
  quote: z.string().trim().min(12).max(500),
});
const PersonItem = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(80),
  quote: z.string().trim().min(12).max(500),
});
/** "S3", "P0" or 3: small models write the labels of the lists as well as their numbers. */
const Index = z.preprocess((v) => (typeof v === 'string' ? Number(v.replace(/^[A-Za-z]+/, '')) : v), z.number().int());
const ScenarioItem = z.object({
  title: z.string().trim().min(3).max(80),
  premise: z.string().trim().min(10).max(260),
  person: Index.nullish().catch(null),
  invented: z.boolean().catch(false),
  steps: z.array(z.object({
    stop: Index,
    text: z.string().trim().min(5).max(260),
    cast: z.array(Index.catch(-1)).max(8).catch([]),
  }).nullable().catch(null)).max(8),
});
export const ExtractedStory = z.object({
  stops: z.array(StopItem.nullable().catch(null)).max(24).catch([]),
  people: z.array(PersonItem.nullable().catch(null)).max(12).catch([]),
});
export const ExtractedScenarios = z.object({
  scenarios: z.array(ScenarioItem.nullable().catch(null)).max(6).catch([]),
});
type StopItem = z.infer<typeof StopItem>;
type PersonItem = z.infer<typeof PersonItem>;
export type ScenarioItem = z.infer<typeof ScenarioItem>;

const SYSTEM = `You read a Wikipedia article about a historical subject (an event, a ship, a building, a battle, a person...) and lay out its story as places a visitor of an interactive globe can travel to.
Return two lists.
1. stops: the places and moments of the story, in three phases:
   - "before": its origins: where it was conceived, built, founded or prepared, and the events that led to it;
   - "during": the places where it happened or that it went through (ports of departure and of call, the route, the site of the event, where people fled or were rescued);
   - "after": what it led to: later events, wars, trials, inquiries, rescues, burials, reconstructions, memorials.
   For each: name (the place or event as the article names it), article (the title of the Wikipedia article about that very event or place, e.g. "Harland & Wolff", "Attentat du World Trade Center de 1993"; never the subject's own article; null if none), at_subject (true when the stop happens at the subject's own location: its main event, e.g. the sinking for a ship, the attack for a building, the battle itself, and later events there, e.g. the discovery of a wreck; false for every other place, construction sites and ports included), modern_place (findable on a map today, in the article's language, followed by its country, e.g. "Southampton, Royaume-Uni", "Cobh, Irlande", "Lower Manhattan, New York, États-Unis"; for an event, the place where it happened), year (the year the article gives for that stop, historical: negative before Christ, no year 0; skip a stop the article gives no year for), label (its part in the story, in French, 2 to 6 words, e.g. "Port de départ", "Escale à Cherbourg", "Lieu du naufrage", "Riposte américaine"), phase, quote.
   Aim for 8 to ${MAX_STOPS}, covering the three phases: for a voyage, every port of departure and of call, the place of the event, where the survivors were brought; for a war or an attack, each place struck and each later event the article names. Always include the main event (phase "during", at_subject = true). Every other stop must have a place on a map (a city, a port, a building, a site), not an ocean or a country.
2. people: the people of the story the article names (builders, commanders, victims, survivors, perpetrators, rescuers, witnesses...). For each: name (full name, as in their own Wikipedia article), role (in French, 2 to 8 words, e.g. "Commandant du navire", "Architecte des tours"), quote. At most ${MAX_PEOPLE}.
Rules, all mandatory:
- ONLY what the article states explicitly; quote = the words of the article (copied verbatim, 12 to 300 characters, one sentence) that state it. Never add knowledge of your own. Fewer items are better than doubtful ones.
Answer with a single JSON object: {"stops": [...], "people": [...]}.`;

const SCENARIOS_SYSTEM = `You write short interactive scenarios for a visitor of a historical globe: walks through the story of a subject, step by step, in someone's shoes.
You get how the visitor looks at the world (with the angle to take) and the cards they explored before, the checked stops of the story (S0, S1...), its people (P0, P1...), and the subject's Wikipedia article.
Scenarios come in a set of ${MAX_SCENARIOS} (you may be asked for one of them at a time):
- the first ${REAL_SCENARIOS} follow REAL people of the list (person = their index, a different one each, invented = false): those whose part in the story best fits the angle;
- the last one follows an INVENTED character, a typical person of the time and place the article describes, chosen for the angle (person = null, invented = true): e.g. for a merchant, a cargo agent or a shipowner's clerk rather than a tourist.
  If fewer than ${REAL_SCENARIOS} people are listed, write invented characters instead.
The angle is mandatory: it decides who is followed, what the premise says and what each step tells (a merchant's scenario speaks of freight, tickets, money, ports and trade; a strategist's of decisions, orders and their consequences). When a card explored before connects to this subject, the premise starts from that link (e.g. coming from a port, the character left from it or works for it).
For each scenario: title (French, a few words), premise (French, one sentence in the second person, "Vous êtes...", saying the character's angle), person, invented, steps (3 to 6, in the order of time, across the phases the character lived; each: stop = the number of one of the stops; text = what this character lives there, in French, two sentences in the second person, with the concrete facts the article gives there (times, numbers, names, decisions), no filler about feelings; cast = the numbers of the listed people the article places there at that moment (on board, on site), the protagonist included when real, at most ${MAX_CAST}; nobody who was not yet born, already dead, or elsewhere).
Rules, all mandatory:
- Only the stops and people listed. Never invent events, dates or deeds the article does not support: the character may be imagined, the history may not.
- A real person only at steps of their adult life where the article involves them, and never with a role before they held it (a future mayor is not yet mayor).
- A step happens in its stop's year: choose the stop whose year is when the character lives that moment (a 1985 discovery is never on a 1912 stop), within a real person's lifetime (given with the people).
Answer with a single JSON object: {"scenarios": [...]}.`;

/** What each lens looks for, told to the AI writing scenarios. */
const LENS_ANGLES: Record<string, string> = {
  strategist: 'command, decisions, orders, power and their consequences',
  pilgrim: 'faith, prayer, clergy, sacred places and how belief met the event',
  merchant: 'freight, tickets and fares, money, shipowners, ports, markets and trade',
  scholar: 'techniques, engineering, science, inquiries and what was learned',
  traveler: 'the route, the crossing, landscapes, ports of call and the journey itself',
  builder: 'construction, architecture, shipyards, building sites and monuments',
};

/**
 * Is a geocoder's answer the place asked for? Its name holds the place's own
 * name (before the first comma): "Cobh, Ireland" → "Cobh, Comté de Cork,
 * Irlande", not some village answering "Carpathia". Pure, for tests.
 */
export function namesMatch(asked: string, found: string): boolean {
  const want = normalize(asked.split(',')[0]!).split(' ').filter((w) => w.length >= 3);
  const got = new Set(normalize(found).split(' '));
  return want.length === 0 || want.filter((w) => got.has(w)).length / want.length >= 0.5;
}

/**
 * The same person's name: every word of the shorter one in the longer one
 * ("Robert Ballard" in "Robert Duane Ballard"), whole words only ("Grimm" is
 * not "Grimmer"). Pure, for tests.
 */
export function sameName(a: string, b: string): boolean {
  const [short, long] = [tokens(a), tokens(b)].sort((x, y) => x.length - y.length);
  return short!.length > 0 && short!.every((w) => long!.includes(w));
}

/** A stop's Wikidata item: an event of the story's year, or a place that already existed then. Pure, for tests. */
export function fitsStory(row: Pick<DatedRow, 'year' | 'prop'>, year: number): boolean {
  const d = histToAstro(row.year) - histToAstro(year);
  return Math.abs(d) <= YEAR_SLACK || (row.prop === 'P571' && d <= 0);
}

/**
 * A stop's year near the subject's time: origins a few centuries before at
 * most, consequences up to now (small models copy the prompt's example years). Pure, for tests.
 */
export function plausibleYear(poi: Pick<Poi, 'date_start' | 'date_end'>, year: number): boolean {
  const start = histToAstro(poi.date_start);
  return histToAstro(year) >= start - 300 && year <= MAX_YEAR;
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

/** Alive that year (from birth on, or from `adult` years of age), as far as Wikidata knows. Pure, for tests. */
export function aliveIn(p: { born: number | null; died: number | null }, year: number, adult = 0): boolean {
  const y = histToAstro(year);
  return (p.born === null || histToAstro(p.born) + adult <= y) && (p.died === null || histToAstro(p.died) >= y);
}

/**
 * Does a step's text speak of its own moment? A text naming only other
 * years ("En 1964, vous…" on the 1973 inauguration) belongs elsewhere. Pure, for tests.
 */
export function textFitsYear(text: string, year: number): boolean {
  const years = [...text.matchAll(/\b(1\d{3}|20\d{2})\b/g)].map((m) => Number(m[1]));
  return years.length === 0 || years.some((y) => Math.abs(y - year) <= 1);
}

/** Index of the listed person a text names by their surname (the longest match), if any. Pure, for tests. */
export function namedIn(text: string, persons: { name: string }[]): number | undefined {
  const words = new Set(tokens(text));
  let best: { i: number; n: number } | undefined;
  persons.forEach((p, i) => {
    const t = tokens(p.name);
    const surname = t[t.length - 1];
    if (!surname || !words.has(surname)) return;
    const n = t.filter((w) => words.has(w)).length;
    if (!best || n > best.n) best = { i, n };
  });
  return best?.i;
}

/** Age from which a real protagonist acts in a step. */
const ADULT = 15;

/**
 * Scenarios that only walk through kept stops, steps in the order of time,
 * at least two of them; the cast among the people alive then (Ballard, born
 * in 1942, is not on the quay in 1912), a real protagonist only at steps of
 * their adult life; up to two following real people (one each), then
 * invented characters, three at most. Pure, for tests.
 */
export function buildScenarios(
  items: ScenarioItem[], stops: { year: number }[], persons: { name: string; born: number | null; died: number | null }[],
): StoryScenario[] {
  const real: StoryScenario[] = [];
  const invented: StoryScenario[] = [];
  const followed = new Set<number>();
  for (const sc of items) {
    // The premise says whom it follows ("Vous êtes Thomas Andrews…"): small models number the list off by one.
    const person = sc.invented ? null : namedIn(sc.premise, persons) ?? null;
    if (!sc.invented && person === null) continue;
    const isReal = person !== null;
    const seen = new Set<number>();
    const steps = sc.steps.flatMap((st) => {
      if (!st || !stops[st.stop] || seen.has(st.stop)) return [];
      const year = stops[st.stop]!.year;
      if ((isReal && !aliveIn(persons[person]!, year, ADULT)) || !textFitsYear(st.text, year)) return [];
      seen.add(st.stop);
      const cast = [...new Set(st.cast.filter((c) => c >= 0 && c < persons.length && aliveIn(persons[c]!, year)))].slice(0, MAX_CAST);
      return [{ stop: st.stop, text: st.text, cast }];
    }).sort((a, b) => histToAstro(stops[a.stop]!.year) - histToAstro(stops[b.stop]!.year));
    if (steps.length < 2) continue;
    if (isReal) {
      if (followed.has(person) || real.length >= REAL_SCENARIOS) continue;
      followed.add(person);
      real.push({ title: sc.title, premise: sc.premise, steps, person, invented: false });
    } else if (sc.invented) {
      invented.push({ title: sc.title, premise: sc.premise, steps, person: null, invented: true });
    }
  }
  return [...real, ...invented.slice(0, MAX_SCENARIOS - real.length)];
}

/** The visitor's view, for the AI. Pure, for tests. */
export function describeContext(ctx: ScenarioContext): string {
  const lens = LENSES.find((l) => l.id === ctx.lens && l.id !== 'all');
  const themes = ctx.themes.length === THEMES.length ? 'all themes' : ctx.themes.map((t) => THEME_LABELS[t]).join(', ') || 'none';
  return [
    lens ? `Lens: « ${lens.label} » (${lens.title}). Angle to take: ${LENS_ANGLES[lens.id] ?? lens.title}.` : 'Lens: none in particular. Angle to take: the most human sides of the story.',
    `Themes shown on the map: ${themes}.${ctx.people ? '' : ' People hidden.'}`,
    ctx.trail.length ? `Cards explored before this one, oldest first: ${ctx.trail.map((t) => `« ${t} »`).join(' → ')}.` : 'This is the first card explored.',
  ].join('\n');
}

/** Scenarios are kept per card and way of looking: the view, and the card just before (not the whole walk). */
export function contextKey(ctx: ScenarioContext): string {
  const view = ctx.lens && ctx.lens !== 'all' ? ctx.lens : [...ctx.themes].sort().join(',');
  return `${view}|${ctx.people ? 1 : 0}|${normalize(ctx.trail.at(-1) ?? '')}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** How far from the subject's card a stop "at the subject" may be named. */
const SUBJECT_KM = 1200;
/** How far a sea's middle may be from the subject for an event "at sea" to happen at the subject. */
const SEA_KM = 2500;
const SEA = /^(ocean|mer|golfe|detroit|manche|atlantique|pacifique|mediterranee|baltique|north sea|sea|gulf|strait)\b/;
/** A sea, not a place: "Atlantique Nord", "Océan Indien", "Mer du Nord". Pure, for tests. */
export function atSea(place: string): boolean {
  return SEA.test(normalize(place.split(',')[0]!));
}
/** Nominatim kinds too wide to stand for a stop. */
const VAGUE = new Set(['ocean', 'sea', 'continent', 'country', 'state', 'region', 'archipelago', 'road', 'postcode', 'house_number']);

/** As kept on disk: stops remember their Wikidata row, so an evicted card can be built again. */
interface StoredStory extends Story { rows: (DatedRow | null)[] }
interface Entry { at: number; v: number; story: StoredStory | null }
/** `story`: when the story they walk through was read (its stops are numbered by that reading). */
interface ScenariosEntry { at: number; v: number; story: number; scenarios: StoryScenario[] }
interface Job { key: string; run: () => Promise<void> }

export class StoryService {
  private cache: Record<string, Entry> = {};
  private scenarioCache: Record<string, ScenariosEntry> = {};
  private queue: Job[] = [];
  private reading: string | null = null;
  private failed = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private file: string | null, private router: ProviderRouter) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { stories?: Record<string, Entry>; scenarios?: Record<string, ScenariosEntry> };
        this.cache = raw.stories ?? {};
        this.scenarioCache = raw.scenarios ?? {};
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
    this.enqueue(key, async () => {
      const story = await this.read(poi);
      this.cache[key] = { at: Date.now(), v: STORY_VERSION, story };
      console.log(`[story] ${poi.title}: ${story ? `${story.stops.length} stops, ${story.people.length} people` : 'nothing found'}`);
    });
    return { status: old ? 'ready' : 'pending', story: old };
  }

  /** Scenarios for the visitor's view, once the story is known: written once per view, then kept. */
  async scenarios(poi: Poi, ctx: ScenarioContext): Promise<ScenariosResponse> {
    const storyKey = this.key(poi);
    const hit = this.cache[storyKey];
    if (!hit || hit.v !== STORY_VERSION) return { status: 'pending', scenarios: [] };
    if (!hit.story) return { status: 'none', scenarios: [] };
    const key = `${storyKey}|${contextKey(ctx)}`;
    const done = this.scenarioCache[key];
    if (done && done.v === SCENARIOS_VERSION && done.story === hit.at && (done.scenarios.length || Date.now() - done.at < EMPTY_RETRY_MS)) {
      return { status: done.scenarios.length ? 'ready' : 'none', scenarios: done.scenarios };
    }
    if (!this.router.canRun('write')) return { status: 'no-ai', scenarios: [] };
    const story = hit.story;
    const storyAt = hit.at;
    this.enqueue(key, async () => {
      const scenarios = await this.write(poi, story, ctx);
      this.scenarioCache[key] = { at: Date.now(), v: SCENARIOS_VERSION, story: storyAt, scenarios };
      const keys = Object.keys(this.scenarioCache);
      if (keys.length > SCENARIOS_KEEP) for (const old of keys.slice(0, keys.length - SCENARIOS_KEEP)) delete this.scenarioCache[old];
      console.log(`[story] scenarios for ${poi.title} (${contextKey(ctx)}): ${scenarios.length}`);
    });
    return { status: 'pending', scenarios: [] };
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    if (this.reading === key || (this.failed.get(key) ?? 0) > Date.now()) return;
    // The latest asked comes first: the visitor has moved on from the others.
    this.queue = [{ key, run }, ...this.queue.filter((j) => j.key !== key)].slice(0, QUEUE_MAX);
    if (!this.reading) void this.pump();
  }

  /** One reading at a time: free AI quotas are small. */
  private async pump(): Promise<void> {
    const job = this.queue.shift();
    if (!job) return;
    this.reading = job.key;
    try {
      await job.run();
      this.scheduleSave();
    } catch (e) {
      this.failed.set(job.key, Date.now() + FAILED_RETRY_MS);
      console.warn(`[story] ${job.key} failed:`, (e as Error).message);
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
      'extract', SYSTEM, `Article « ${article.title} » :\n\n${article.text}`, (v) => ExtractedStory.parse(v), 5000,
    );
    if (!answer) throw new Error('no AI available');
    const ok = <T extends { quote: string }>(x: T | null): x is T => !!x && grounded(article.text, x.quote);
    const fits = (y: number) => y !== 0 && y >= MIN_YEAR && y <= MAX_YEAR;
    const links = (await wikipedia.linkedItems(lang, article.title).catch(() => [])).filter((l) => l.qid !== poi.wikidata_qid);

    // Stops: one per place and moment, found on the map.
    const items = answer.value.stops.filter(ok).filter((s) => fits(s.year) && plausibleYear(poi, s.year));
    const unique = new Map<string, StopItem>();
    for (const s of items) {
      const key = s.at_subject ? `subject|${s.year}` : `${normalize(s.name)}|${s.year}`;
      if (!unique.has(key)) unique.set(key, s);
    }
    // One after another, like people: Wikidata and Nominatim turn bursts down.
    const located: { stop: StoryStop; row: DatedRow | null }[] = [];
    for (const item of [...unique.values()].slice(0, MAX_STOPS)) {
      const found = await this.locate(poi, item, lang, links).catch((e) => {
        console.warn(`[story] could not place ${item.name}:`, (e as Error).message);
        return null;
      });
      if (found) located.push(found);
    }
    const order = (p: StoryPhase) => STORY_PHASES.indexOf(p);
    located.sort((a, b) => order(a.stop.phase) - order(b.stop.phase) || histToAstro(a.stop.year) - histToAstro(b.stop.year));
    const stops = located.map((l) => l.stop);
    if (stops.length === 0) return null;

    const lastYear = Math.max(poi.date_end ?? poi.date_start, ...stops.map((s) => s.year));
    return {
      stops,
      people: await this.findPeople(answer.value.people.filter(ok), lang, lastYear, poi.wikidata_qid, links),
      rows: located.map((l) => l.row),
      source: { url: article.url, title: `Wikipédia : ${article.title}`, kind: 'wikipedia' },
      provider: answer.provider,
    };
  }

  /** Scenarios over the checked stops and people, for the visitor's view. */
  private async write(poi: Poi, story: StoredStory, ctx: ScenarioContext): Promise<StoryScenario[]> {
    const article = await wikipedia.pageText(poi.wiki_lang ?? 'fr', poi.wiki_title!, SCENARIO_ARTICLE_CHARS);
    if (!article) return [];
    const user = [
      `Subject: « ${poi.title} ».`,
      describeContext(ctx),
      '',
      'Stops:',
      ...story.stops.map((s, i) => `S${i}. year ${s.year} · ${s.label} · ${s.poi?.title ?? s.name}`),
      '',
      story.people.length ? 'People:' : 'People: none listed.',
      // Lifetimes, so a step is not put before someone's birth (Ballard at the 1912 sinking).
      ...story.people.map((p, i) => `P${i}. ${p.name} (${p.born ?? '?'}–${p.died ?? ''}), ${p.role}`),
      '',
      `Article « ${article.title} » :`,
      '',
      article.text,
    ].join('\n');
    const ask = async (extra: string) => {
      const answer = await this.router.completeJson('write', SCENARIOS_SYSTEM, extra ? `${user}\n\n${extra}` : user, (v) => ExtractedScenarios.parse(v), 5000);
      if (!answer) throw new Error('no AI available');
      return answer.value.scenarios.filter((x): x is ScenarioItem => !!x);
    };
    // One scenario per request: three at once take a small model past its time limit, or it writes only one.
    // The first real one and the invented one together, then the second real one (another person).
    const real = (taken: string) => ask(`This time write exactly ONE scenario, following a REAL person of the list${taken ? ` other than ${taken}` : ''} (invented = false).`);
    const invented = () => ask('This time write exactly ONE scenario, following an INVENTED character (person = null, invented = true).');
    const items: ScenarioItem[] = [];
    const wantReal = Math.min(REAL_SCENARIOS, story.people.length);
    const settled = await Promise.allSettled([wantReal ? real('') : invented(), invented()]);
    for (const r of settled) if (r.status === 'fulfilled') items.push(...r.value);
    const build = () => buildScenarios(items, story.stops, story.people);
    // Whatever is still missing (a second real person, a failed request), alone, a few times at most.
    for (let tries = 0; tries < MAX_SCENARIOS; tries++) {
      const built = build();
      const followed = built.filter((x) => !x.invented);
      const next = followed.length < wantReal ? real(followed.map((x) => `P${x.person}`).join(', ')) : built.length < MAX_SCENARIOS ? invented() : null;
      if (!next) break;
      items.push(...await next.catch(() => [] as ScenarioItem[]));
    }
    const out = build();
    // Nothing usable is not kept: tried again later rather than shown empty for days.
    if (out.length === 0) throw new Error('no usable scenario');
    return out;
  }

  /**
   * A stop on the map: its Wikidata item when one fits the story (an event
   * of that year, a place that already existed then, where the geocoders
   * put it), with a card; else the subject's own place for a stop there (the
   * wreck, the towers) or out at sea nearby; else the place found by the
   * geocoders, without a card. Items the article links to come first: they
   * are the ones it means.
   */
  private async locate(poi: Poi, s: StopItem, lang: string, links: Link[]): Promise<{ stop: StoryStop; row: DatedRow | null } | null> {
    const base = { phase: s.phase, name: s.name, label: cap(s.label), year: s.year };
    const here = { stop: { ...base, lat: poi.lat, lon: poi.lon, poi: null }, row: null };
    // Out at sea ("Atlantique Nord") no geocoder names a place: the nearest
    // answer is a namesake ("Bassin de l'Atlantique", Dunkerque).
    const sea = atSea(s.modern_place) || atSea(s.name);
    // Small models give the subject's own article for every stop: no help to find this one.
    const article = s.article && normalize(s.article) !== normalize(poi.title) && normalize(s.article) !== normalize(poi.wiki_title ?? '') ? s.article : null;
    const linked = [...new Set([...(article ? linkMatches(article, links).slice(0, 3) : []), ...linkMatches(s.name, links).slice(0, 3)])];
    const searched = (await wikidata.searchItems(article || s.name, lang, 3).catch(() => [] as string[]))
      .filter((q) => q !== poi.wikidata_qid && !linked.includes(q));
    const qids = [...linked, ...searched];
    const [rows, place] = await Promise.all([
      qids.length ? wikidata.queryDatedByQids(qids, MIN_YEAR, MAX_YEAR + 1).catch(() => []) : Promise.resolve([]),
      sea ? Promise.resolve(null) : this.geocode(s.modern_place, lang),
    ]);
    // At sea, only an event fits ("Naufrage du Titanic"), not a ship's own item.
    const row = qids
      .map((q) => rows.find((r) => r.qid === q))
      .find((r): r is DatedRow => !!r && fitsStory(r, s.year) && (!sea || r.prop !== 'P571') && nearEnough(r, place, linked.includes(r.qid)));
    if (row) {
      const card = await this.cardOf(row);
      return { stop: { ...base, lat: row.lat, lon: row.lon, poi: card && toLite(card) }, row };
    }
    // The subject's own place, unless the place named is clearly elsewhere (small models mark the shipyard too).
    if (s.at_subject && (!place || distanceKm(place, poi) <= SUBJECT_KM)) return here;
    if (sea) {
      // Only a sea's own answer says which sea; it must be the subject's.
      const water = (await geocode.nominatimSearch(s.modern_place, undefined, 1).catch(() => []))[0];
      return !water || !VAGUE.has(water.kind ?? '') || distanceKm(water, poi) <= SEA_KM ? here : null;
    }
    if (!place) return null;
    return { stop: { ...base, lat: Math.round(place.lat * 1e4) / 1e4, lon: Math.round(place.lon * 1e4) / 1e4, poi: null }, row: null };
  }

  /**
   * "Cobh, Ireland" on the map: Nominatim reads it best, Wikidata for the
   * name alone otherwise. An ocean, a country or a region is no place to
   * travel to ("North Atlantic" is its middle): none.
   */
  private async geocode(modern: string, lang: string): Promise<{ lat: number; lon: number } | null> {
    const hit = (await geocode.nominatimSearch(modern, undefined, 1).catch(() => []))[0];
    if (hit && VAGUE.has(hit.kind ?? '')) return null;
    if (hit && namesMatch(modern, hit.name)) return hit;
    // Another name for it ("London" answered "Londres"), or nothing: Wikidata, by name, in the article's language.
    const named = (await geocode.wikidataPlaces(modern.split(',')[0]!.trim(), lang, 3).catch(() => []))[0];
    return named && namesMatch(modern, named.name) ? named : null;
  }

  private async cardOf(row: DatedRow): Promise<Poi | null> {
    await this.store.upsertPois(await buildPois([row], this.store));
    return (await this.store.getPoisByQids([row.qid]))[0] ?? null;
  }

  private async findPeople(items: PersonItem[], lang: string, lastYear: number, self: string | null, links: Link[]): Promise<StoryPerson[]> {
    // One after another: in parallel, Wikidata turns some lookups down and people vanish.
    const out: StoryPerson[] = [];
    for (const item of items.slice(0, MAX_PEOPLE * 2)) {
      if (out.length >= MAX_PEOPLE) break;
      try {
        const linked = linkMatches(item.name, links).slice(0, 4);
        const searched = linked.length ? [] : await wikidata.searchItems(item.name, lang, 3);
        const qids = [...new Set([...linked, ...searched])].filter((q) => q !== self);
        const hits = await people.peopleByQids(qids);
        // The article's links first, then search order: the best known namesake is not always the one meant.
        // A search answers by prefix ("Jack Grimm" → "Jack Grimmer"): its hits must bear the name asked;
        // a person with no readable name (only "Q42574") is no use on a card.
        const hit = qids
          .map((q) => hits.find((h) => h.qid === q))
          .find((h) => !!h && !/^Q\d+$/.test(h.name) && livedThen(h, lastYear) && (linked.includes(h.qid) || sameName(item.name, h.name)));
        if (hit && !out.some((p) => p.qid === hit.qid)) {
          out.push({ qid: hit.qid, name: hit.name, role: cap(item.role), born: hit.born, died: hit.died, image: hit.image });
        }
      } catch (e) {
        console.warn(`[story] could not look up ${item.name}:`, (e as Error).message);
      }
    }
    return out;
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
        writeFileSync(this.file!, JSON.stringify({ stories: this.cache, scenarios: this.scenarioCache }));
      } catch (e) {
        console.warn('[story] could not save cache:', (e as Error).message);
      }
    }, 2000);
    this.saveTimer.unref();
  }
}
