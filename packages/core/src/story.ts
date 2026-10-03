import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ACTIVITY_LABELS, distanceKm, histToAstro, LENSES, MAX_YEAR, MIN_YEAR, STORY_PHASES, THEME_LABELS, THEMES, toLite,
  type ActivityKind, type DetourKind, type PersonJourney, type PersonScenarioResponse, type Poi, type PoiLite, type ScenarioContext, type ScenarioWalk,
  type ScenariosResponse, type Source, walkOf, type Story, type StoryPerson, type StoryResponse, type StoryScenario, type StoryStop,
} from '@way/shared';
import { people, wikidata, wikipedia, type DatedRow, type EntityInfo } from '@way/providers';
import { normalize } from './links.ts';
import { buildPois } from './pipeline.ts';
import type { ProviderRouter } from './router.ts';
import { bestMention, isPlace, labelOf, type Mention, mentionsOf, phaseOf, rankMentions } from './skeleton.ts';
import type { Store } from './store/types.ts';

// The story of a subject, beyond the five doors, read from the card's
// Wikipedia article in two passes. First its bones, in seconds and without
// AI: every article it links to with coordinates is a place of the story
// (where the Titanic was built, the ports it called at, where it sank, what
// it led to), dated and phased by the sentence and section linking it; the
// linked Wikidata humans are its people. Then an AI only labels them (their
// part in the story, the main ones), from those sentences. Scenarios are
// written over the same stops, for the visitor's lens and themes and the
// cards that led them here: two follow real people, the last an invented
// character, with the people present at each step. All kept on disk.

/** Bump when the reading changes: stories are read again. */
const STORY_VERSION = 12;
const SCENARIOS_VERSION = 10;
const PERSON_VERSION = 3;
/** What scenario writers read of an article besides the stops' own sentences: its start. */
const SCENARIO_ARTICLE_CHARS = 5_000;
/** A life's article, read further: it is the only text of that walk. */
const PERSON_ARTICLE_CHARS = 12_000;
/** Linked articles looked up, best first; places kept; the main ones, shown first. */
const MAX_LINKS = 400;
const MAX_STOPS = 60;
const MAIN_STOPS = 14;
/** People looked up among the linked articles without coordinates, and kept. */
const PEOPLE_LOOKUP = 120;
const MAX_PEOPLE = 10;
const MAX_SCENARIOS = 3;
/** Real people followed by scenarios; the rest are invented characters. */
const REAL_SCENARIOS = 2;
const MAX_CAST = 4;
/** Steps of a scenario: one per stop the character lives, as many as the story allows. */
const MAX_STEPS = 12;
/** A person's life: stops offered to the AI, and the fewest steps worth a walk. */
const MAX_PERSON_STOPS = 20;
const MIN_PERSON_STEPS = 3;
/** A detour off a walk: a few moments around the one the visitor branched from. */
const DETOUR_STOPS = 4;
const DETOUR_MIN = 2;
const DETOUR_MAX = 3;
/** Scenarios kept on disk (one set per card and way of looking). */
const SCENARIOS_KEEP = 2000;
const EMPTY_RETRY_MS = 7 * 86_400_000;
const FAILED_RETRY_MS = 30 * 60_000;
/** AI jobs asked meanwhile wait here, the latest first; older ones are dropped. */
const QUEUE_MAX = 8;
/** AI jobs at once: a card's labels and its scenarios go side by side. */
const CONCURRENCY = 2;
/** Two places of the same kind closer than this are one (two articles for one town). */
const SAME_SPOT_KM = 12;
/** Wikidata classes too wide to travel to, whatever the article's {{coord}} says: countries, regions, seas. */
const VAGUE_CLASSES = new Set([
  'Q6256', 'Q3624078', 'Q3336843', 'Q7275', 'Q107390', 'Q35657', 'Q11828004', 'Q36784', 'Q10864048', 'Q1620908', 'Q82794',
  'Q5107', 'Q9430', 'Q165', 'Q2418896', 'Q3455524',
]);
type LatLon = { lat: number; lon: number };
/** A sentence of the article, as told to the AI. */
const NOTE_CHARS = 220;

const Labels = z.object({
  stops: z.array(z.object({
    i: z.preprocess((v) => (typeof v === 'string' ? Number(v.replace(/^[A-Za-z]+/, '')) : v), z.number().int()),
    label: z.string().trim().min(2).max(60),
    phase: z.enum(STORY_PHASES).catch('during'),
    main: z.boolean().catch(false),
  }).nullable().catch(null)).max(MAX_STOPS + 10).catch([]),
  people: z.array(z.object({
    i: z.preprocess((v) => (typeof v === 'string' ? Number(v.replace(/^[A-Za-z]+/, '')) : v), z.number().int()),
    role: z.string().trim().min(2).max(80),
    main: z.boolean().catch(false),
  }).nullable().catch(null)).max(MAX_PEOPLE + 10).catch([]),
});
export const StoryLabels = Labels;

const LABEL_SYSTEM = `You label the places and people of a historical subject's story for a visitor of an interactive globe.
You get the subject, then the places its Wikipedia article links to (S0, S1...: name, year, the section of the article, and the sentence that mentions it), then the people it links to (P0, P1...: name, lifetime, description, sentence).
Return, for EVERY place: i (its number), label (in French, 2 to 6 words: its part in THIS story, e.g. "Chantier de construction", "Port de départ", "Escale à Cherbourg", "Lieu du naufrage", "Arrivée des rescapés", "Commission d'enquête"), phase ("before": origins, construction, causes; "during": where it happened; "after": consequences, inquiries, memorials, discoveries), main (true for the places that are part of the story itself, 8 to ${MAIN_STOPS} of them: where it was conceived, built, departed, called at, happened, where people were rescued or brought, and its direct consequences, discoveries and memorials; false for places only cited in passing: comparisons, other ships or buildings, home towns, later unrelated events). A sentence may name several places: the label says the part of THIS place only.
And for EVERY person: i, role (in French, 2 to 8 words: their part in this story, e.g. "Commandant du navire", "Architecte naval"), main (true for at most 6 people central to the story).
Rules: only what the sentences say; never add knowledge of your own.
Answer with a single JSON object: {"stops": [...], "people": [...]}.`;

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
  }).nullable().catch(null)).max(MAX_STEPS + 4),
});
export const ExtractedScenarios = z.object({
  scenarios: z.array(ScenarioItem.nullable().catch(null)).max(6).catch([]),
});
export type ScenarioItem = z.infer<typeof ScenarioItem>;

const SCENARIOS_SYSTEM = `You write short interactive scenarios for a visitor of a historical globe: walks through the story of a subject, step by step, in someone's shoes.
You get how the visitor looks at the world (with the angle to take) and the cards they explored before, the checked stops of the story (S0, S1...: year, part in the story, place, and the article's sentence about it; ★ marks the main ones), its people (P0, P1..., with their sentence), and the start of the subject's Wikipedia article. Prefer the main stops; the others may add a step where the character's angle leads there.
Scenarios come in a set of ${MAX_SCENARIOS} (you may be asked for one of them at a time):
- the first ${REAL_SCENARIOS} follow REAL people of the list (person = their index, a different one each, invented = false): those whose part in the story best fits the angle;
- the last one follows an INVENTED character, a typical person of the time and place the article describes, chosen for the angle (person = null, invented = true): e.g. for a merchant, a cargo agent or a shipowner's clerk rather than a tourist.
  If fewer than ${REAL_SCENARIOS} people are listed, write invented characters instead.
The angle is mandatory: it decides who is followed, what the premise says and what each step tells (a merchant's scenario speaks of freight, tickets, money, ports and trade; a strategist's of decisions, orders and their consequences). When a card explored before connects to this subject, the premise starts from that link (e.g. coming from a port, the character left from it or works for it).
For each scenario: title (French, a few words), premise (French, one sentence in the second person, "Vous êtes...", saying the character's angle), person, invented, steps (one per stop this character lives, as many as the stops allow: ideally 6 to ${MAX_STEPS}, never fewer than 3 when there are enough stops; in the order of time, across the phases the character lived; each: stop = the number of one of the stops; text = what this character lives there, in French, two sentences in the second person, with the concrete facts the article gives there (times, numbers, names, decisions), no filler about feelings; cast = the numbers of the listed people the article places there at that moment (on board, on site), the protagonist included when real, at most ${MAX_CAST}; nobody who was not yet born, already dead, or elsewhere).
Rules, all mandatory:
- Only the stops and people listed. Never invent events, dates or deeds the article does not support: the character may be imagined, the history may not.
- A real person only at steps of their adult life where the article involves them, and never with a role before they held it (a future mayor is not yet mayor).
- A step happens in its stop's year: choose the stop whose year is when the character lives that moment (a 1985 discovery is never on a 1912 stop), within a real person's lifetime (given with the people).
Answer with a single JSON object: {"scenarios": [...]}.`;

const PERSON_SYSTEM = `You write ONE interactive scenario for a visitor of a historical globe: a walk through the life of a REAL person, step by step, in their shoes.
You get how the visitor looks at the world (with the angle to take), the checked places of that person's life (S0, S1...: from Wikidata, and from the stories of subjects they took part in), and their Wikipedia article.
Write: title (French, a few words), premise (French, one sentence in the second person, "Vous êtes <their full name>...", saying the angle), person = null, invented = false, steps (one per place they live, as many as the article supports: ideally 6 to ${MAX_STEPS}, in the order of time; each: stop = the number of one of the places; text = what they live there, in French, two sentences in the second person, with the concrete facts the article gives for that moment (dates, numbers, names, decisions), no filler about feelings; cast = []).
The angle is mandatory: it decides what the premise says and what each step tells.
Rules, all mandatory:
- Only the places listed. Never invent events, dates or deeds the article does not support; skip a place the article says nothing about.
- A step happens in its place's year: its text speaks of that moment, never of another year.
Answer with a single JSON object: {"scenarios": [ { ...the scenario... } ]}.`;

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

const tokens = (s: string) => normalize(s.replace(/\([^)]*\)/g, ' ')).split(' ').filter(Boolean);

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
    }).sort((a, b) => histToAstro(stops[a.stop]!.year) - histToAstro(stops[b.stop]!.year)).slice(0, MAX_STEPS);
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

/** A place of a real person's life: from their Wikidata journey, or a stop of a card's story they took part in. */
export interface PersonStop {
  place: string;
  label: string;
  year: number;
  lat: number;
  lon: number;
  poi: PoiLite | null;
  /** The card whose story it comes from, if any. */
  card: string | null;
}

/** Moments a journey guesses (on the way, waiting) are no places to stop at. */
const GUESSED: ActivityKind[] = ['travel', 'sail', 'wait'];
/** Two places of a life the same year closer than this are the same moment. */
const SAME_PLACE_KM = 100;
/** Which moments of a life are kept first when there are too many. */
const KIND_RANK: Partial<Record<ActivityKind, number>> = { birth: 0, death: 0, battle: 1, coronation: 1, reign: 1, office: 2, event: 2, marriage: 3 };

/**
 * The places of someone's life, in the order of time: the stops of the card
 * stories they appear in (within their lifetime), then their placed Wikidata
 * moments, one per place and year; when too many, births, deaths, battles
 * and reigns before studies and stays. Pure, for tests.
 */
export function personStops(j: PersonJourney, stories: { title: string; stops: StoryStop[] }[], max = MAX_PERSON_STOPS): PersonStop[] {
  const life = { born: j.born === null ? null : Math.floor(j.born), died: j.died === null ? null : Math.floor(j.died) };
  const seen = new Set<string>();
  const out: (PersonStop & { rank: number })[] = [];
  const add = (s: PersonStop, rank: number) => {
    const key = `${normalize(s.place)}|${s.year}`;
    // The same moment told twice (the sinking in the story, the death at sea in Wikidata): once.
    if (seen.has(key) || !aliveIn(life, s.year) || out.some((o) => o.year === s.year && distanceKm(o, s) < SAME_PLACE_KM)) return;
    seen.add(key);
    out.push({ ...s, rank });
  };
  for (const story of stories) {
    for (const s of story.stops) add({ place: s.poi?.title ?? s.name, label: s.label, year: s.year, lat: s.lat, lon: s.lon, poi: s.poi, card: story.title }, 0);
  }
  for (const s of j.stops) {
    if (s.lat === null || s.lon === null || GUESSED.includes(s.kind)) continue;
    add({ place: s.label, label: ACTIVITY_LABELS[s.kind], year: Math.floor(s.start), lat: s.lat, lon: s.lon, poi: null, card: null }, KIND_RANK[s.kind] ?? 4);
  }
  const kept = [...out].sort((a, b) => a.rank - b.rank).slice(0, max);
  return kept.sort((a, b) => histToAstro(a.year) - histToAstro(b.year)).map(({ rank: _, ...s }) => s);
}

/**
 * A person's life as a walk: only the stops listed, each once, in the order
 * of time, while they lived, the text speaking of that moment; none under
 * MIN_PERSON_STEPS steps. Pure, for tests.
 */
export function buildPersonWalk(
  item: ScenarioItem, stops: PersonStop[], hero: StoryPerson, source: Source,
  limits: { min: number; max: number; id?: string } = { min: MIN_PERSON_STEPS, max: MAX_STEPS },
): ScenarioWalk | null {
  const seen = new Set<number>();
  const steps = item.steps.flatMap((st) => {
    const s = st && stops[st.stop];
    if (!st || !s || seen.has(st.stop) || !aliveIn(hero, s.year) || !textFitsYear(st.text, s.year)) return [];
    seen.add(st.stop);
    return [{ place: s.place, label: s.label, year: s.year, lat: s.lat, lon: s.lon, poi: s.poi, text: st.text, cast: [hero] }];
  }).sort((a, b) => histToAstro(a.year) - histToAstro(b.year)).slice(0, limits.max);
  if (steps.length < limits.min) return null;
  return { id: limits.id ?? `${hero.qid}|${item.title}`, title: item.title, premise: item.premise, invented: false, hero, steps, source, from: null };
}

/**
 * The `n` moments closest in time to `year` (the one branched from), back
 * in the order of time: a detour stays around that moment. Pure, for tests.
 */
export function nearMoment<T extends { year: number }>(stops: T[], year: number, n = DETOUR_STOPS): T[] {
  const y = histToAstro(year);
  return stops
    .map((s, i) => ({ s, i, d: Math.abs(histToAstro(s.year) - y) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, n)
    .sort((a, b) => histToAstro(a.s.year) - histToAstro(b.s.year) || a.i - b.i)
    .map((x) => x.s);
}

/** What the AI is told of the walk a detour branches off. Pure, for tests. */
export function detourAsk(year: number, from: string): string {
  return `This time write exactly ONE short DETOUR: ${DETOUR_MIN} to ${DETOUR_MAX} steps only, each at a DIFFERENT listed stop (never the same stop twice), the stops nearest to the year ${year}. `
    + `The visitor branches off the scenario « ${from} » at that moment: the premise starts from it (what links this character to that moment), and the title is new (not « ${from} »).`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sentence linking each stop and person, kept for the AI: the labels and scenarios are written from them. */
interface Notes { stops: string[]; sections: string[]; people: string[] }

/** As kept on disk: stops remember their Wikidata row, so an evicted card can be built again. */
interface StoredStory extends Story {
  rows: (DatedRow | null)[];
  notes: Notes;
  /** Labelled by an AI (their part in the story, the main ones), or still the article's headings. */
  labelled: boolean;
}
interface Entry { at: number; v: number; story: StoredStory | null }
/** `story`: when the story they walk through was read (its stops are numbered by that reading); `partial`: more on the way. */
interface ScenariosEntry { at: number; v: number; story: number; scenarios: StoryScenario[]; partial?: boolean }
interface PersonEntry { at: number; v: number; walk: ScenarioWalk | null }
interface Job { key: string; run: () => Promise<void> }

type Labelled = z.infer<typeof Labels>;

/**
 * An AI's labels over the bones: each stop's part in the story and phase,
 * the main ones (as many as it marks, MAIN_STOPS at most, the bones' own
 * choice when it marks too few), the people it calls central first. Stops
 * keep their order: scenarios number them. Pure, for tests.
 */
export function applyLabels<S extends Pick<StoryStop, 'label' | 'phase' | 'main'>, P extends Pick<StoryPerson, 'role'>>(
  stops: S[], persons: P[], labels: Labelled,
): { stops: S[]; people: P[] } {
  const byStop = new Map(labels.stops.flatMap((l) => (l && stops[l.i] ? [[l.i, l] as const] : [])));
  const marked = [...byStop.values()].filter((l) => l.main).length;
  let main = 0;
  const outStops = stops.map((s, i) => {
    const l = byStop.get(i);
    if (!l) return { ...s, main: marked >= 4 ? false : s.main };
    const isMain = marked >= 4 ? l.main && main++ < MAIN_STOPS : s.main;
    return { ...s, label: cap(l.label), phase: l.phase, main: isMain };
  });
  const byPerson = new Map(labels.people.flatMap((l) => (l && persons[l.i] ? [[l.i, l] as const] : [])));
  const outPeople = persons.map((p, i) => ({ p: byPerson.has(i) ? { ...p, role: cap(byPerson.get(i)!.role) } : p, main: !!byPerson.get(i)?.main, i }))
    .sort((a, b) => Number(b.main) - Number(a.main) || a.i - b.i)
    .map((x) => x.p);
  return { stops: outStops, people: outPeople };
}

/**
 * A place's year: of the years its sentence gives, the first one fitting
 * the phase its headings say (during the subject, before it, after it), else
 * the first one; else the year the paragraph gave; else the years its
 * section gives most; else the subject's start. Pure, for tests.
 */
export function yearOf(
  m: Mention, all: Mention[], plausible: (y: number) => boolean, subject: { start: number; end: number },
): number {
  const said = m.years.filter(plausible);
  const hint = phaseOf({ ...m, year: null }, subject);
  const [start, end] = [histToAstro(subject.start), histToAstro(subject.end)];
  const fits = (y: number) => {
    const a = histToAstro(y);
    return hint === 'before' ? a <= start : hint === 'after' ? a > end : a >= start - 1 && a <= end + 1;
  };
  const fallback = subject.start;
  if (said.length) return said.find(fits) ?? said[0]!;
  if (m.year !== null && plausible(m.year)) return m.year;
  const section = m.path[m.path.length - 1];
  const counts = new Map<number, number>();
  for (const o of all) if (o.year !== null && plausible(o.year) && o.path[o.path.length - 1] === section) counts.set(o.year, (counts.get(o.year) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? fallback;
}

/** Stops as told to the writers: number, year, part, place, ★ when main, the article's sentence. */
function stopLines(stops: StoryStop[], notes: string[] | null): string[] {
  return stops.map((s, i) => `S${i}. ${s.main === false ? '' : '★ '}year ${s.year} · ${s.label} · ${s.poi?.title ?? s.name}${notes?.[i] ? ` — « ${notes[i]!.slice(0, NOTE_CHARS)} »` : ''}`);
}

export class StoryService {
  private cache: Record<string, Entry> = {};
  private scenarioCache: Record<string, ScenariosEntry> = {};
  private personCache: Record<string, PersonEntry> = {};
  private queue: Job[] = [];
  private running = new Set<string>();
  /** Bones being read (no AI, not queued): one reading per card. */
  private sketching = new Map<string, Promise<void>>();
  private failed = new Map<string, number>();
  /** Stories whose stops' cards are being made: shown meanwhile without them. */
  private cardsPending = new WeakSet<(DatedRow | null)[]>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private file: string | null, private router: ProviderRouter) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as {
          stories?: Record<string, Entry>; scenarios?: Record<string, ScenariosEntry>; persons?: Record<string, PersonEntry>;
        };
        this.cache = raw.stories ?? {};
        this.scenarioCache = raw.scenarios ?? {};
        this.personCache = raw.persons ?? {};
      } catch {
        /* corrupt cache: read again */
      }
    }
  }

  private key = (poi: Poi) => poi.wikidata_qid ?? poi.id;

  /** The story as known now: its bones read in seconds the first time, labelled by an AI meanwhile (`draft`). */
  async get(poi: Poi): Promise<StoryResponse> {
    const key = this.key(poi);
    const hit = this.cache[key];
    const fresh = hit && hit.v === STORY_VERSION && (hit.story || Date.now() - hit.at < EMPTY_RETRY_MS);
    if (fresh) {
      if (!hit.story) return { status: 'none', story: null };
      this.label(poi, key);
      return { status: 'ready', story: await this.resolve(hit.story), draft: this.drafting(key) };
    }
    const old = hit?.story ? await this.resolve(hit.story) : null;
    if (!poi.wiki_title) return { status: old ? 'ready' : 'none', story: old };
    if ((this.failed.get(key) ?? 0) > Date.now()) return { status: old ? 'ready' : 'none', story: old };
    if (!this.sketching.has(key)) {
      const run = this.read(poi)
        .then((story) => {
          this.cache[key] = { at: Date.now(), v: STORY_VERSION, story };
          this.scheduleSave();
          console.log(`[story] ${poi.title}: ${story ? `${story.stops.length} places (${story.stops.filter((s) => s.main).length} main), ${story.people.length} people` : 'nothing found'}`);
          if (story) this.label(poi, key);
        })
        .catch((e) => {
          this.failed.set(key, Date.now() + FAILED_RETRY_MS);
          console.warn(`[story] ${poi.title} failed:`, (e as Error).message);
        })
        .finally(() => this.sketching.delete(key));
      this.sketching.set(key, run);
    }
    // An older reading meanwhile: shown, and asked again for the new one.
    return { status: old ? 'ready' : 'pending', story: old, draft: !!old };
  }

  /** Still to be labelled by an AI that may answer. */
  private drafting(key: string): boolean {
    const s = this.cache[key]?.story;
    return !!s && !s.labelled && this.router.canRun('extract') && (this.failed.get(`label|${key}`) ?? 0) <= Date.now();
  }

  /** The AI labels the bones: each place's part in the story, the main ones, the people's roles. */
  private label(poi: Poi, key: string): void {
    if (!this.drafting(key)) return;
    this.enqueue(`label|${key}`, async () => {
      const entry = this.cache[key];
      const s = entry?.story;
      if (!entry || !s || s.labelled) return;
      const user = [
        `Subject: « ${poi.title} » (${poi.date_start}${poi.date_end && poi.date_end !== poi.date_start ? `–${poi.date_end}` : ''}).`,
        '',
        'Places:',
        ...s.stops.map((st, i) => `S${i}. ${st.poi?.title ?? st.name} · year ${st.year} · section « ${s.notes.sections[i] ?? ''} » — « ${(s.notes.stops[i] ?? '').slice(0, NOTE_CHARS)} »`),
        '',
        s.people.length ? 'People:' : 'People: none.',
        ...s.people.map((p, i) => `P${i}. ${p.name} (${p.born ?? '?'}–${p.died ?? ''}), ${p.role} — « ${(s.notes.people[i] ?? '').slice(0, NOTE_CHARS)} »`),
      ].join('\n');
      const answer = await this.router.completeJson('extract', LABEL_SYSTEM, user, (v) => Labels.parse(v), 6000);
      if (!answer) throw new Error('no AI available');
      const now = this.cache[key];
      // Read again meanwhile: these labels number another reading.
      if (now !== entry) return;
      // People reordered: their notes follow them.
      const labelled = applyLabels(s.stops, s.people.map((p, i) => ({ ...p, note: s.notes.people[i] ?? '' })), answer.value);
      const persons = labelled.people.map(({ note: _, ...p }) => p);
      this.cache[key] = {
        ...entry,
        story: { ...s, stops: labelled.stops, people: persons, labelled: true, provider: answer.provider, notes: { ...s.notes, people: labelled.people.map((p) => p.note) } },
      };
      console.log(`[story] labels for ${poi.title}: ${labelled.stops.filter((x) => x.main).length} main places`);
    });
  }

  /** Scenarios for the visitor's view, once the story is known: written once per view, then kept; given as they come (`more`). */
  async scenarios(poi: Poi, ctx: ScenarioContext): Promise<ScenariosResponse> {
    const storyKey = this.key(poi);
    const hit = this.cache[storyKey];
    if (!hit || hit.v !== STORY_VERSION) return { status: 'pending', scenarios: [] };
    if (!hit.story) return { status: 'none', scenarios: [] };
    const key = `${storyKey}|${contextKey(ctx)}`;
    const done = this.scenarioCache[key];
    if (done && done.v === SCENARIOS_VERSION && done.story === hit.at && (done.scenarios.length || Date.now() - done.at < EMPTY_RETRY_MS)) {
      // Left half-written (a restart): the rest is asked again.
      const more = !!done.partial && (this.busy(key) || this.router.canRun('write'));
      if (done.partial && !this.busy(key) && more) this.queueScenarios(poi, ctx, key, hit);
      // With the reading they number: the card may still show an older one.
      return done.scenarios.length
        ? { status: 'ready', scenarios: done.scenarios, story: await this.resolve(hit.story), more }
        : { status: 'none', scenarios: [] };
    }
    if (!this.router.canRun('write')) return { status: 'no-ai', scenarios: [] };
    this.queueScenarios(poi, ctx, key, hit);
    return { status: 'pending', scenarios: [] };
  }

  private queueScenarios(poi: Poi, ctx: ScenarioContext, key: string, hit: Entry): void {
    const storyAt = hit.at;
    const keep = (scenarios: StoryScenario[], partial: boolean) => {
      this.scenarioCache[key] = { at: Date.now(), v: SCENARIOS_VERSION, story: storyAt, scenarios, partial };
      const keys = Object.keys(this.scenarioCache);
      if (keys.length > SCENARIOS_KEEP) for (const old of keys.slice(0, keys.length - SCENARIOS_KEEP)) delete this.scenarioCache[old];
    };
    this.enqueue(key, async () => {
      // The labels may have come meanwhile: the latest of the same reading.
      const story = this.cache[this.key(poi)]?.at === storyAt ? this.cache[this.key(poi)]!.story! : hit.story!;
      const scenarios = await this.write(poi, story, ctx, (first) => keep(first, true));
      keep(scenarios, false);
      console.log(`[story] scenarios for ${poi.title} (${contextKey(ctx)}): ${scenarios.length}`);
    });
  }

  private busy(key: string): boolean {
    return this.running.has(key) || this.queue.some((j) => j.key === key);
  }

  /**
   * A real person's life as a scenario, for the visitor's view: across the
   * card stories they appear in and their Wikidata moments, written once per
   * view, then kept.
   */
  async personScenario(j: PersonJourney, ctx: ScenarioContext): Promise<PersonScenarioResponse> {
    const key = `person|${j.qid}|${contextKey(ctx)}`;
    const done = this.personCache[key];
    if (done && done.v === PERSON_VERSION && (done.walk || Date.now() - done.at < EMPTY_RETRY_MS)) {
      return { status: done.walk ? 'ready' : 'none', walk: done.walk };
    }
    if ((this.failed.get(key) ?? 0) > Date.now()) return { status: 'none', walk: null };
    if (!this.router.canRun('write')) return { status: 'no-ai', walk: null };
    this.enqueue(key, async () => {
      const walk = await this.writePerson(j, ctx);
      this.personCache[key] = { at: Date.now(), v: PERSON_VERSION, walk };
      const keys = Object.keys(this.personCache);
      if (keys.length > SCENARIOS_KEEP) for (const old of keys.slice(0, keys.length - SCENARIOS_KEEP)) delete this.personCache[old];
      console.log(`[story] life of ${j.name} (${contextKey(ctx)}): ${walk ? `${walk.steps.length} steps` : 'too few places'}`);
    });
    return { status: 'pending', walk: null };
  }

  /**
   * A short detour off a walk, near the year branched from: a real person's
   * moments around it (in their shoes), or an invented character at a
   * place's card (its story read first). `skip`: the item of the card whose
   * story the visitor branches from (a person's detour goes elsewhere when it
   * can). Written once per view, then kept.
   */
  async detour(
    target: { kind: 'person'; journey: PersonJourney } | { kind: 'card'; poi: Poi }, year: number, from: string, ctx: ScenarioContext,
    skip: string | null = null,
  ): Promise<PersonScenarioResponse> {
    const kind: DetourKind = target.kind;
    const id = target.kind === 'person' ? target.journey.qid : this.key(target.poi);
    const key = `detour|${kind}|${id}|${year}|${normalize(from)}|${skip ?? ''}|${contextKey(ctx)}`;
    const done = this.personCache[key];
    if (done && done.v === PERSON_VERSION && (done.walk || Date.now() - done.at < EMPTY_RETRY_MS)) {
      return { status: done.walk ? 'ready' : 'none', walk: done.walk };
    }
    if ((this.failed.get(key) ?? 0) > Date.now()) return { status: 'none', walk: null };
    if (!this.router.canRun('write')) return { status: 'no-ai', walk: null };
    let write: () => Promise<ScenarioWalk | null>;
    if (target.kind === 'card') {
      // The place's own story first: a detour walks through its stops.
      const story = await this.get(target.poi);
      if (!story.story) return { status: story.status, walk: null };
      const hit = this.cache[id];
      if (!hit?.story || hit.v !== STORY_VERSION) return { status: 'pending', walk: null };
      const stored = hit.story;
      write = () => this.writeCardDetour(target.poi, stored, year, from, ctx);
    } else {
      write = () => this.writePerson(target.journey, ctx, { year, from, skip });
    }
    this.enqueue(key, async () => {
      const walk = await write();
      this.personCache[key] = { at: Date.now(), v: PERSON_VERSION, walk };
      console.log(`[story] detour ${kind} ${id} near ${year}: ${walk ? `${walk.steps.length} steps` : 'too few places'}`);
    });
    return { status: 'pending', walk: null };
  }

  /** An invented character's detour through the main stops of a place's story nearest to the year branched from. */
  private async writeCardDetour(poi: Poi, stored: StoredStory, year: number, from: string, ctx: ScenarioContext): Promise<ScenarioWalk | null> {
    const story = await this.resolve(stored);
    const near = nearMoment(story.stops.map((s, i) => ({ ...s, i })).filter((s) => s.main !== false), year);
    const sub: Story = { ...story, stops: near.map(({ i: _, ...s }) => s) };
    if (sub.stops.length < DETOUR_MIN) return null;
    const article = await wikipedia.pageText(poi.wiki_lang ?? 'fr', poi.wiki_title!, SCENARIO_ARTICLE_CHARS);
    const user = [
      `Subject: « ${poi.title} ».`,
      describeContext(ctx),
      '',
      'Stops:',
      ...stopLines(sub.stops, near.map((s) => stored.notes.stops[s.i] ?? '')),
      '',
      sub.people.length ? 'People:' : 'People: none listed.',
      ...sub.people.map((p, i) => `P${i}. ${p.name} (${p.born ?? '?'}–${p.died ?? ''}), ${p.role}`),
      ...(article ? ['', `Start of the article « ${article.title} » :`, '', article.text] : []),
      '',
      `${detourAsk(year, from)} Follow an INVENTED character (person = null, invented = true).`,
    ].join('\n');
    // A small model sometimes answers off the list: once more before giving up for a while.
    for (let tries = 0; tries < 2; tries++) {
      const answer = await this.router.completeJson('write', SCENARIOS_SYSTEM, user, (v) => ExtractedScenarios.parse(v), 3000);
      if (!answer) throw new Error('no AI available');
      const items = answer.value.scenarios.filter((x): x is ScenarioItem => !!x).map((x) => ({ ...x, invented: true }));
      const sc = buildScenarios(items, sub.stops, sub.people).find((x) => x.invented);
      if (sc) {
        const walk = walkOf(toLite(poi), sub, { ...sc, steps: sc.steps.slice(0, DETOUR_MAX) });
        return { ...walk, id: `${walk.id}|détour|${year}` };
      }
    }
    throw new Error('no usable detour');
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    if (this.running.has(key) || (this.failed.get(key) ?? 0) > Date.now()) return;
    // The latest asked comes first: the visitor has moved on from the others.
    this.queue = [{ key, run }, ...this.queue.filter((j) => j.key !== key)].slice(0, QUEUE_MAX);
    this.pump();
  }

  /** A couple of AI jobs at a time: free AI quotas are small. */
  private pump(): void {
    while (this.running.size < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.running.add(job.key);
      void job.run()
        .then(() => this.scheduleSave())
        .catch((e) => {
          this.failed.set(job.key, Date.now() + FAILED_RETRY_MS);
          console.warn(`[story] ${job.key} failed:`, (e as Error).message);
        })
        .finally(() => {
          this.running.delete(job.key);
          this.pump();
        });
    }
  }

  /**
   * The bones of the story, from the article's links: those with
   * coordinates of a travelable kind are its places (dated by the sentence
   * linking them, phased by its section), the Wikidata humans its people.
   * The best ranked are the main ones until an AI says better. No AI here.
   */
  private async read(poi: Poi): Promise<StoredStory | null> {
    const lang = poi.wiki_lang ?? 'fr';
    const page = await wikipedia.pageWikitext(lang, poi.wiki_title!);
    if (!page) return null;
    const subject = { start: poi.date_start, end: poi.date_end ?? poi.date_start };
    const plausible = (y: number) => y !== 0 && y >= MIN_YEAR && y <= MAX_YEAR && plausibleYear(poi, y);
    const mentions = mentionsOf(page.wikitext);
    const infos = await wikipedia.pagesInfo(lang, rankMentions(mentions).slice(0, MAX_LINKS).map((c) => c.target));
    const ranked = rankMentions(mentions, (t) => infos.get(t)?.type ?? null);

    const seen = new Set<string>(poi.wikidata_qid ? [poi.wikidata_qid] : []);
    const candidates = ranked.flatMap((c) => {
      const info = infos.get(c.target);
      if (!info?.qid || seen.has(info.qid) || !isPlace(info)) return [];
      seen.add(info.qid);
      return [{ c, info }];
    }).slice(0, MAX_STOPS + 30);
    // People: the linked articles without coordinates that are Wikidata humans.
    const others = ranked.filter((c) => {
      const info = infos.get(c.target);
      return info?.qid && info.lat === null && !seen.has(info.qid);
    }).slice(0, PEOPLE_LOOKUP);
    // Side by side: the places' classes, for the countries and regions an article's {{coord}} calls
    // cities ("Angleterre"); their Wikidata rows, which make cards of them (the article's link says
    // which item, whatever its date); the people.
    const [classes, rows, hits] = await Promise.all([
      wikidata.queryEntityInfo(candidates.map((p) => p.info.qid!)).catch(() => new Map<string, EntityInfo>()),
      wikidata.queryDatedByQids(candidates.map((p) => p.info.qid!), MIN_YEAR, MAX_YEAR + 1).catch(() => [] as DatedRow[]),
      people.peopleByQids(others.map((c) => infos.get(c.target)!.qid!)).catch(() => []),
    ]);
    const places: typeof candidates = [];
    for (const p of candidates) {
      if (places.length >= MAX_STOPS) break;
      if (classes.get(p.info.qid!)?.classes.some((k) => VAGUE_CLASSES.has(k))) continue;
      // The same place under two articles (Cherbourg-Octeville, Cherbourg-en-Cotentin): once, the better ranked.
      if (places.some((q) => q.info.type === p.info.type && distanceKm(q.info as LatLon, p.info as LatLon) < SAME_SPOT_KM)) continue;
      places.push(p);
    }
    if (places.length === 0) return null;
    const kept = new Set(places.map((p) => p.info.qid!));
    const rowOf = new Map(rows.filter((r) => kept.has(r.qid)).map((r) => [r.qid, r]));
    // Cards already made now; the others are made meanwhile (the story is shown without waiting for them).
    const cards = new Map((await this.store.getPoisByQids([...rowOf.keys()]).catch(() => [] as Poi[])).map((p) => [p.wikidata_qid, p]));

    const order = (p: StoryStop['phase']) => STORY_PHASES.indexOf(p);
    const built = places.map(({ c, info }, rank) => {
      const m = bestMention(c.mentions, plausible);
      const year = yearOf(m, mentions, plausible, subject);
      const card = cards.get(info.qid!);
      const stop: StoryStop = {
        phase: phaseOf({ ...m, year }, subject), name: info.title, label: labelOf(m), year,
        lat: Math.round(info.lat! * 1e4) / 1e4, lon: Math.round(info.lon! * 1e4) / 1e4, poi: card ? toLite(card) : null, main: rank < MAIN_STOPS,
      };
      return { stop, row: rowOf.get(info.qid!) ?? null, note: m.sentence, section: m.field ?? m.path[0] ?? 'Introduction' };
    }).sort((a, b) => order(a.stop.phase) - order(b.stop.phase) || histToAstro(a.stop.year) - histToAstro(b.stop.year));

    // People of the story's time.
    const lastYear = Math.max(subject.end, ...built.map((b) => b.stop.year));
    const persons = others.flatMap((c) => {
      const h = hits.find((x) => x.qid === infos.get(c.target)!.qid);
      if (!h || /^Q\d+$/.test(h.name) || !livedThen(h, lastYear)) return [];
      if (h.died !== null && histToAstro(h.died) < histToAstro(subject.start) - 30) return [];
      return [{ p: { qid: h.qid, name: h.name, role: cap((h.description ?? 'Personnage de l’histoire').slice(0, 60)), born: h.born, died: h.died, image: h.image }, note: bestMention(c.mentions, plausible).sentence }];
    }).slice(0, MAX_PEOPLE);

    const storedRows = built.map((b) => b.row);
    const missing = [...rowOf.values()].filter((r) => !cards.has(r.qid));
    if (missing.length) {
      this.cardsPending.add(storedRows);
      void buildPois(missing, this.store)
        .then((pois) => this.store.upsertPois(pois))
        .catch((e) => console.warn(`[story] cards for ${poi.title}:`, (e as Error).message))
        .finally(() => this.cardsPending.delete(storedRows));
    }
    return {
      stops: built.map((b) => b.stop),
      people: persons.map((x) => x.p),
      rows: storedRows,
      notes: { stops: built.map((b) => b.note), sections: built.map((b) => b.section), people: persons.map((x) => x.note) },
      labelled: false,
      source: { url: page.url, title: `Wikipédia : ${page.title}`, kind: 'wikipedia' },
      provider: 'wikipedia',
    };
  }

  /**
   * Scenarios over the stops and people, for the visitor's view. The first
   * ones come together (`first` is told of them: the card can offer them
   * while the rest are written).
   */
  private async write(poi: Poi, story: StoredStory, ctx: ScenarioContext, first: (s: StoryScenario[]) => void): Promise<StoryScenario[]> {
    const article = await wikipedia.pageText(poi.wiki_lang ?? 'fr', poi.wiki_title!, SCENARIO_ARTICLE_CHARS).catch(() => null);
    const user = [
      `Subject: « ${poi.title} ».`,
      describeContext(ctx),
      '',
      'Stops:',
      ...stopLines(story.stops, story.notes.stops),
      '',
      story.people.length ? 'People:' : 'People: none listed.',
      // Lifetimes, so a step is not put before someone's birth (Ballard at the 1912 sinking).
      ...story.people.map((p, i) => `P${i}. ${p.name} (${p.born ?? '?'}–${p.died ?? ''}), ${p.role}${story.notes.people[i] ? ` — « ${story.notes.people[i]!.slice(0, NOTE_CHARS)} »` : ''}`),
      ...(article ? ['', `Start of the article « ${article.title} » :`, '', article.text] : []),
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
    if (build().length) first(build());
    // Whatever is still missing (a second real person, a failed request), alone, a few times at most.
    for (let tries = 0; tries < MAX_SCENARIOS; tries++) {
      const built = build();
      const followed = built.filter((x) => !x.invented);
      const next = followed.length < wantReal ? real(followed.map((x) => `P${x.person}`).join(', ')) : built.length < MAX_SCENARIOS ? invented() : null;
      if (!next) break;
      items.push(...await next.catch(() => [] as ScenarioItem[]));
      if (build().length) first(build());
    }
    const out = build();
    // Nothing usable is not kept: tried again later rather than shown empty for days.
    if (out.length === 0) throw new Error('no usable scenario');
    return out;
  }

  /** Someone's life over the main stops of the stories they took part in and their own Wikidata moments; null when too few. */
  private async writePerson(
    j: PersonJourney, ctx: ScenarioContext, detour?: { year: number; from: string; skip: string | null },
  ): Promise<ScenarioWalk | null> {
    // The card stories already read where they appear: their main stops become theirs.
    const appears = Object.entries(this.cache)
      .filter(([, e]) => e.v === STORY_VERSION && e.story?.people.some((p) => p.qid === j.qid))
      .slice(0, 8);
    const cards = new Map((await this.store.getPoisByQids(appears.map(([k]) => k)).catch(() => [] as Poi[])).map((p) => [p.wikidata_qid, p]));
    const stories = await Promise.all(appears.map(async ([k, e]) => ({
      qid: k, title: cards.get(k)?.title ?? k, stops: (await this.resolve(e.story!)).stops.filter((s) => s.main !== false),
    })));
    // A detour keeps the moments around the one branched from, out of the whole life, elsewhere
    // than the story branched from when the life has enough (it already walks through those).
    const around = (from: typeof stories) => nearMoment(personStops(j, from, MAX_PERSON_STOPS * 2), detour!.year);
    const elsewhere = detour?.skip ? around(stories.filter((s) => s.qid !== detour.skip)) : [];
    const stops = !detour ? personStops(j, stories) : elsewhere.length >= DETOUR_MIN ? elsewhere : around(stories);
    const limits = detour
      ? { min: DETOUR_MIN, max: DETOUR_MAX, id: `${j.qid}|détour|${detour.year}` }
      : { min: MIN_PERSON_STEPS, max: MAX_STEPS };
    if (stops.length < limits.min) return null;

    const info = (await wikidata.queryEntityInfo([j.qid])).get(j.qid);
    const lang = info?.frTitle ? 'fr' : 'en';
    const title = info?.frTitle ?? info?.enTitle;
    const article = title ? await wikipedia.pageText(lang, title, PERSON_ARTICLE_CHARS) : null;
    if (!article) return null;
    const year = (y: number | null) => (y === null ? null : Math.floor(y));
    const hero: StoryPerson = { qid: j.qid, name: j.name, role: j.description ?? '', born: year(j.born), died: year(j.died), image: j.image };
    const user = [
      `Person: ${j.name} (${hero.born ?? '?'}–${hero.died ?? ''})${j.description ? `, ${j.description}` : ''}.`,
      describeContext(ctx),
      '',
      'Places of their life:',
      ...stops.map((s, i) => `S${i}. year ${s.year} · ${s.label} · ${s.place}${s.card ? ` (story of « ${s.card} »)` : ''}`),
      '',
      `Article « ${article.title} » :`,
      '',
      article.text,
      ...(detour ? ['', detourAsk(detour.year, detour.from)] : []),
    ].join('\n');
    const source: Source = { url: article.url, title: `Wikipédia : ${article.title}`, kind: 'wikipedia' };
    // A small model sometimes answers off the list: once more before giving up for a while.
    for (let tries = 0; tries < 2; tries++) {
      const answer = await this.router.completeJson('write', PERSON_SYSTEM, user, (v) => ExtractedScenarios.parse(v), 5000);
      if (!answer) throw new Error('no AI available');
      const item = answer.value.scenarios.find((x): x is ScenarioItem => !!x);
      const walk = item && buildPersonWalk(item, stops, hero, source, limits);
      if (walk) return walk;
    }
    throw new Error(detour ? 'no usable detour' : 'no usable life scenario');
  }

  /** Cards of the stops, built again if the cache evicted them. */
  private async resolve(s: StoredStory): Promise<Story> {
    const qids = s.rows.flatMap((r) => (r ? [r.qid] : []));
    let byQid = new Map((await this.store.getPoisByQids(qids)).map((p) => [p.wikidata_qid, p]));
    const missing = s.rows.filter((r): r is DatedRow => !!r && !byQid.has(r.qid));
    if (missing.length && !this.cardsPending.has(s.rows)) {
      await this.store.upsertPois(await buildPois(missing, this.store)).catch(() => {});
      byQid = new Map((await this.store.getPoisByQids(qids)).map((p) => [p.wikidata_qid, p]));
    }
    const { rows, notes: _n, labelled: _l, ...story } = s;
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
        writeFileSync(this.file!, JSON.stringify({ stories: this.cache, scenarios: this.scenarioCache, persons: this.personCache }));
      } catch (e) {
        console.warn('[story] could not save cache:', (e as Error).message);
      }
    }, 2000);
    this.saveTimer.unref();
  }
}
