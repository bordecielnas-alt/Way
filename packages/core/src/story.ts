import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ACTIVITY_LABELS, CATEGORY_THEME, dateToDecimal, distanceKm, formatDay, histToAstro, LENSES, MAX_YEAR, MIN_YEAR, STORY_PHASES, THEME_LABELS, THEMES, toLite,
  type ActivityKind, type Category, type DetourKind, type PersonJourney, type PersonScenarioResponse, type Poi, type PoiLite, type ScenarioContext, type ScenarioWalk,
  type CardLink, type ScenarioFork, type ScenariosResponse, type Source, type StepChoice, type StepPicture, type StepQuote, type StepResponse, walkOf, type WalkStep, type Story, type StoryPerson, type StoryResponse, type StoryScenario, type StoryStop,
} from '@way/shared';
import { people, wikidata, wikipedia, type DatedRow, type EntityInfo } from '@way/providers';
import { grounded, normalize } from './links.ts';
import { buildPois } from './pipeline.ts';
import type { ProviderRouter } from './router.ts';
import { bestMention, isPlace, labelOf, leadLinks, type Mention, mentionsOf, phaseOf, rankMentions, type Section, sectionOf } from './skeleton.ts';
import type { Store } from './store/types.ts';

// The story of a subject, beyond the five doors, read from the card's
// Wikipedia article in two passes. First its bones, in seconds and without
// AI: every article it links to with coordinates is a place of the story
// (where the Titanic was built, the ports it called at, where it sank, what
// it led to), dated and phased by the sentence and section linking it; the
// linked Wikidata humans are its people. Then an AI only labels them (their
// part in the story, the main ones), from those sentences. Scenarios are
// planned over the same stops, for the visitor's lens and themes and the
// cards that led them here: one follows a real person, one a thing of the
// story (the freight, a ship), one an idea (the faith, a technique). Each step is written on arrival as a short
// illustrated section of an encyclopedia, from the article's own section
// about it: its people, its pictures and captions, the subjects it links to.
// All kept on disk.

/** Bump when the reading changes: stories are read again. */
const STORY_VERSION = 14;
const SCENARIOS_VERSION = 18;
const PERSON_VERSION = 5;
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
/** Real people followed by scenarios; the others follow a thing, then an idea. */
const REAL_SCENARIOS = 1;
const MAX_CAST = 4;
/** People shown at a written step: the protagonist, then those its passage names, in its order. */
const STEP_CAST = 6;
/** Steps of a scenario: one per stop the character lives, as many as the story allows (their texts come later). */
const MAX_STEPS = 15;
const MIN_PLAN_STEPS = 8;
/** Turning points planned with a walk, and the stops of each. */
const MAX_FORKS = 2;
const FORK_STOPS = 4;
/** Two steps of a walk the same year closer than this are one stop (the port and its town). */
const SAME_STEP_KM = 15;
/** A step written on arrival: the places of the story offered for its detours, the texts kept on disk. */
const STEP_CANDIDATES = 5;
/** Links read in a card's introduction, and the articles whose links are kept. */
const MAX_LINKS_LEAD = 40;
const LINKS_KEEP = 300;
/** Bump when steps are written differently: they are written again. */
const STEP_VERSION = 11;
/** A step's text: a few paragraphs, each a few sentences (a long one is cut in two). */
const MIN_PARAGRAPHS = 3;
const MAX_PARAGRAPHS = 5;
const PARAGRAPH_SPLIT_CHARS = 900;
/** A step's facts, pictures, and the cards close by at its moment (years either side, km, how many known cards looked at). */
const MAX_FACTS = 4;
const GALLERY_MAX = 8;
const NEAR_YEARS = 1;
const NEAR_KM = 200;
/** Detours a step's writer may offer besides the planned route and its turning points. */
const MAX_DETOURS = 3;
/** Subjects a step's passage links to, offered as detours with those close by. */
const LINKED_MAX = 4;
/** Close by at the same moment: events, not towns or institutions; lasting a few years at most. */
const NEAR_CATEGORIES = new Set<Category>(['battle', 'event', 'disaster', 'discovery', 'exploration']);
const NEAR_SPAN = 10;
/** Around the place in Wikidata when few are known, and how long a step waits for them. */
const NEAR_WIKIDATA_KM = 150;
const NEAR_WAIT_MS = 9000;
const NEAR_MAX = 4;
const NEAR_LOOKUP = 4000;
const STEPS_KEEP = 6000;
/** What the step writer reads of the place's own article. */
const SUMMARY_CHARS = 1200;
/** And of the subject's: its section around the step's paragraph, and the start of the article detailing it. */
const SECTION_CHARS = 4500;
const DETAILED_CHARS = 3500;
/** A card's step without a summary: the start of its article's introduction. */
const CARD_LEAD_CHARS = 1500;
/** People offered to a step: those its passage names first, then the story's. */
const STEP_PEOPLE = 14;
const SECTION_LINKS = 60;
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
  thread: z.enum(['thing', 'idea']).nullish().catch(null),
  steps: z.array(z.object({
    stop: Index,
    /** Written later, on arrival (a life's walk still comes with its texts). */
    text: z.string().trim().max(400).catch(''),
    cast: z.array(Index.catch(-1)).max(8).catch([]),
    beat: z.string().trim().max(120).optional().catch(undefined),
  }).nullable().catch(null)).max(MAX_STEPS + 4),
  forks: z.array(z.object({
    at: Index,
    label: z.string().trim().min(3).max(90),
    person: Index.nullish().catch(null),
    stops: z.array(Index.catch(-1)).min(1).max(FORK_STOPS + 2),
  }).nullable().catch(null)).max(4).optional().catch(undefined),
});
export const ExtractedScenarios = z.object({
  scenarios: z.array(ScenarioItem.nullable().catch(null)).max(6).catch([]),
});
export type ScenarioItem = z.infer<typeof ScenarioItem>;
/** "C2" (a place of the story), "K1" (another card), "P0" (someone present), or 2 (a place). */
const Target = z.union([z.string(), z.number()]).transform((v, c) => {
  const m = String(v).trim().match(/^([CKP]?)\s*(\d+)$/i);
  if (!m) {
    c.addIssue({ code: 'custom', message: 'no target' });
    return z.NEVER;
  }
  return { kind: (m[1]!.toUpperCase() || 'C') as 'C' | 'K' | 'P', i: Number(m[2]) };
});
/** A step's paragraphs: a list, or one text split at its blank lines (small models write either). */
const Paragraphs = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(/\n\s*\n/) : v),
  z.array(z.string().trim().max(2400).nullable().catch(null)).min(1).max(10)
    .transform((a) => a.filter((x): x is string => !!x && x.length >= 30))
    .refine((a) => a.length > 0 && a.join(' ').length >= 150, 'too short'),
);
const StepAnswer = z.preprocess(
  (v) => (v && typeof v === 'object' && !('paragraphs' in v) && 'text' in v ? { ...v, paragraphs: (v as { text: unknown }).text } : v),
  z.object({
    paragraphs: Paragraphs,
    next: z.string().trim().min(3).max(90).nullable().catch(null).default(null),
    cast: z.array(Index.catch(-1)).max(8).catch([]),
    facts: z.array(z.string().trim().min(6).max(180).nullable().catch(null)).max(8).catch([]).transform((a) => a.filter((x): x is string => !!x)),
    quote: z.string().trim().min(20).max(400).nullable().catch(null).default(null),
    choices: z.array(z.object({ label: z.string().trim().min(3).max(90), to: Target }).nullable().catch(null)).max(6).catch([]),
  }),
);
export const ExtractedStep = StepAnswer;

const SCENARIOS_SYSTEM = `You plan reading paths for a visitor of a historical globe: walks through the story of a subject, step by step. Each step is written later, when the visitor gets there, as a short illustrated section of an encyclopedia, in the third person: nobody's shoes, no role to play. You choose whom or what each path follows and where it goes.
You get how the visitor looks at the world (lens and themes shown on the map, with the angle to take) and the cards they explored before, the checked stops of the story (S0, S1...: date, part in the story, place, and the article's sentence about it; ★ marks the main ones), its people (P0, P1..., with their sentence), and the start of the subject's Wikipedia article.
Paths come in a set of ${MAX_SCENARIOS} (you may be asked for one of them at a time):
- one follows a REAL person of the list (person = their index, invented = false, thread = null): the one whose part in the story best fits the angle;
- one follows a THING of the story (person = null, invented = true, thread = "thing"): a cargo, a commodity, a ship, a building, money, a weapon, a book, a relic… whatever moves or lasts through the stops, chosen for the angle and the themes shown (for a merchant, the freight and its prices; for a pilgrim, a relic; for a strategist, the guns);
- one follows an IDEA (person = null, invented = true, thread = "idea"): a faith, a technique, a law, a science, a style, a way of trading or ruling, as the story spreads, tests or changes it, chosen for the angle and the themes shown.
  Never an invented character. If no people are listed, write a thing and an idea, then another thing.
The angle is mandatory: it decides who or what is followed, what the premise says and which stops the path goes through, the stops about the themes shown first. When a card explored before connects to this subject, the premise starts from that link.
A path tells a story, not a tour: a thread (what the person did or faced, what the theme shows), stops where that thread meets the events, toward the turning point of the story.
For each path: title (French, a few words, like an article's title, e.g. "Thomas Andrews, l'architecte à bord", "Le fret du Titanic"), premise (French, one or two sentences in the third person and the style of Wikipedia, presenting whom or what the path follows and from what angle; never "vous", never "Vous êtes"), person, invented, thread, steps (one per stop the path goes through, in the order of time, to the day when the stops give dates, across the phases: ${MIN_PLAN_STEPS} to ${MAX_STEPS} when the stops allow, never fewer than 3; mostly main stops, others where the angle leads there; each: stop = the number of one of the stops; text = "" (written later); beat = in French, 3 to 8 words, the step's heading, like the title of an encyclopedia's section, from the stop's sentence (e.g. "L'appareillage de Southampton", "Les messages d'alerte du Baltic"); cast = the numbers of the listed people the article places there at that moment (on board, on site), the person followed included when real, at most ${MAX_CAST}; nobody who was not yet born, already dead, or elsewhere), forks.
forks: 1 or 2 other threads the story could follow from a step, each at a different step: at = the stop number of the step it leaves from; label = in French, 3 to 9 words, the other thread, starting with "Suivre" when it follows someone (e.g. "Suivre Molly Brown dans le canot 6", "Suivre le Carpathia jusqu'à New York"); person = the number of a listed person whose sentence places them there, followed from then on (null to keep the same thread; when the path follows a REAL person, a fork always follows someone else); stops = 1 to ${FORK_STOPS} listed stops that other thread goes through, in the order of time, those whose sentences name that person first, none of the path's own later steps.
Rules, all mandatory:
- Only the stops and people listed.
- A real person only at steps of their adult life where the article involves them, and only where they physically are at that moment: never at a destination they did not reach, never after their death.
- A step happens in its stop's year: choose the stop whose year is that moment (a 1985 discovery is never on a 1912 stop), within a real person's lifetime (given with the people).
Answer with a single JSON object: {"scenarios": [...]}.`;

const STEP_SYSTEM = `You write ONE step of a reading path through a historical subject, for a visitor of a historical globe, when the visitor gets there: a short section of an encyclopedia, in the style of Wikipedia, about this place at this moment.
You get how the visitor looks at the world (the angle to take, the themes shown), the path (title, premise, whom or what it follows, the steps already read, the turns the visitor took), this step's place, date and heading, the passage of the article about it (its section), the start of the article detailing that part when there is one, the place's own article summary, the people (P0, P1...: ★ marks those the passage names), where the planned route goes next and the turning points offered here, places of the story off the route (C0, C1...), and other subjects (K0, K1...: those the passage links to, then those close by at the same moment).
Write:
- paragraphs: in French, ${MIN_PARAGRAPHS} to ${MAX_PARAGRAPHS} paragraphs of 3 to 5 sentences each, in the third person and the past tense, neutral and precise like a Wikipedia article: never "vous", never "je", never inside anyone's head. First the place and the moment (where, when, what the place was then, from its own article); then what happened there, in order, with the names, dates, times and numbers the texts give; then the part of whom or what the path follows, from the angle; last, what came of it and where the story goes from here (the planned way on and the turning points offered, by name, in a sentence, as history: never speak of steps, paths, the visitor or the reader). Tell ONLY this place at this moment: the passage may go on to later moments (other ports, the next days), leave them to their own steps. Follow the texts closely and keep all their facts; pick up from the steps already read, and when the visitor took a turn, say what it brings. Forbidden: invented scenes, dialogue, feelings, hopes and fears, the atmosphere in general, a summary of the whole story;
- next: in French, 3 to 8 words, a heading for the next step on the planned route, written like a section title (e.g. "L'escale de Cherbourg"), never a copy of the route's line; null when the route ends here;
- facts: 3 to ${MAX_FACTS} short facts in French (each under 120 characters, with a date, a time or a number), taken from the passage, the detailed article or the summary, e.g. "10 avril 1912, 12 h : départ de Southampton";
- quote: ONE sentence copied word for word from the passage (not the summary), the most telling one; null if none fits;
- cast: the numbers of the listed people present there at that moment (P0, P1...) as the texts place them, at most ${MAX_CAST}; never someone only because they are listed;
- choices: 0 to ${MAX_DETOURS} short detours from here, before going on: label (French, 3 to 9 words, naming whom or where, e.g. "Suivre Jack Phillips à la cabine radio", "Le sauvetage par le Carpathia"), to = "P" and the number of a person present here (a few moments of their life, then back), "C" and the number of a place of the story off the route (one step there, then the route goes on), or "K" and the number of another subject (a short detour there, then back). Prefer those the passage names or links to, and those about the themes shown; when someone the passage names is present, one detour goes toward them.
Rules, all mandatory: never invent events, dates or deeds the texts do not support; when the texts do not say what a real person did here, say only that they were there; the step happens at its date; a real person only within their lifetime and roles they held then.
Answer with a single JSON object: {"paragraphs": ["...", "..."], "next": "..." or null, "facts": [...], "quote": "..." or null, "cast": [...], "choices": [{"label": "...", "to": "P0"}]}.`;

const PERSON_SYSTEM = `You write ONE reading path for a visitor of a historical globe: a walk through the life of a REAL person, step by step, told in the third person like a Wikipedia article (never in their shoes).
You get how the visitor looks at the world (with the angle to take), the checked places of that person's life (S0, S1...: from Wikidata, and from the stories of subjects they took part in), and their Wikipedia article.
Write: title (French, a few words, like an article's title), premise (French, one sentence in the third person presenting the person and the angle, e.g. "Thomas Andrews (1873-1912), architecte naval de Harland and Wolff, vu sous l'angle de ses chantiers"; never "vous"), person = null, invented = false, steps (one per place of their life, as many as the article supports: ideally 6 to ${MAX_STEPS}, in the order of time; each: stop = the number of one of the places; beat = the step's heading in French, 3 to 8 words; text = what happened to them there, in French, two or three sentences in the third person and the past tense, with the concrete facts the article gives for that moment (dates, numbers, names, decisions), no filler about feelings; cast = []).
The angle is mandatory: it decides what the premise says and what each step tells.
Rules, all mandatory:
- Only the places listed. Never invent events, dates or deeds the article does not support; skip a place the article says nothing about.
- A step happens in its place's year: its text speaks of that moment, never of another year.
Answer with a single JSON object: {"scenarios": [ { ...the path... } ]}.`;

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

const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_WORDS = Object.keys(MONTHS).join('|');
const DAY_FIRST = new RegExp(`\\b(1er|\\d{1,2})\\s+(${MONTH_WORDS})\\s+(\\d{3,4})\\b`, 'gi');
const MONTH_FIRST = new RegExp(`\\b(${MONTH_WORDS})\\s+(\\d{1,2}),?\\s+(\\d{3,4})\\b`, 'gi');
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The day a sentence gives for a moment of that year ("le 10 avril 1912",
 * "April 10, 1912"), as a decimal year; null when it gives none. Pure, for tests.
 */
export function dayOf(text: string, year: number): number | null {
  if (year < 1) return null;
  const flat = fold(text);
  for (const m of flat.matchAll(DAY_FIRST)) {
    if (Number(m[3]) === year) return dateToDecimal(year, MONTHS[m[2]!]!, m[1] === '1er' ? 1 : Number(m[1]));
  }
  for (const m of flat.matchAll(MONTH_FIRST)) {
    if (Number(m[3]) === year) return dateToDecimal(year, MONTHS[m[1]!]!, Number(m[2]));
  }
  return null;
}

/**
 * Steps in the order of time: by year; within a year by day where the stops
 * give it, a step without one keeping the day of the step before it in the
 * plan; then as planned (the input's order: the planner knows the story's
 * order better than the article's links). A step at the same spot as the one
 * just before it the same year is one stop too many (the port, then its town). Pure, for tests.
 */
export function orderSteps<T extends { stop: number }>(steps: T[], stops: { year: number; when?: number | null; lat?: number; lon?: number }[]): T[] {
  const byYear = new Map<number, { st: T; k: number }[]>();
  steps.forEach((st, k) => {
    const s = stops[st.stop];
    if (!s) return;
    const y = histToAstro(s.year);
    byYear.set(y, [...(byYear.get(y) ?? []), { st, k }]);
  });
  const out: T[] = [];
  const at = (st: T): LatLon | null => {
    const s = stops[st.stop]!;
    return s.lat !== undefined && s.lon !== undefined ? { lat: s.lat, lon: s.lon } : null;
  };
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    let last = -Infinity;
    const keyed = byYear.get(y)!.map(({ st, k }) => {
      const w = stops[st.stop]!.when;
      if (w != null) last = w;
      return { st, k, key: w ?? last };
    }).sort((a, b) => a.key - b.key || a.k - b.k);
    // A step without a day far out of the way between the two around it is where the story ends
    // up, not where it passes (New York between Queenstown and the iceberg): last of its year.
    const ends: typeof keyed = [];
    for (let i = 1; i < keyed.length - 1; i++) {
      const [a, b, c] = [at(keyed[i - 1]!.st), at(keyed[i]!.st), at(keyed[i + 1]!.st)];
      if (stops[keyed[i]!.st.stop]!.when != null || !a || !b || !c) continue;
      const [around, direct] = [distanceKm(a, b) + distanceKm(b, c), distanceKm(a, c)];
      if (around > 1.5 * direct + 500 && around - direct > 2000) ends.push(...keyed.splice(i--, 1));
    }
    for (const { st } of [...keyed, ...ends]) {
      const s = stops[st.stop]!;
      const before = out.length ? stops[out[out.length - 1]!.stop]! : null;
      const same = before && histToAstro(before.year) === y && s.lat !== undefined && s.lon !== undefined && before.lat !== undefined && before.lon !== undefined
        && distanceKm(before as LatLon, s as LatLon) < SAME_STEP_KM;
      if (!same) out.push(st);
    }
  }
  return out;
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

type Persons = { name: string; born: number | null; died: number | null }[];
type PlanStops = { year: number; when?: number | null; lat?: number; lon?: number; label?: string; name?: string }[];

/** What a stop says when it is where someone died: a sinking, a death, an execution. */
const DEATH = /(naufrage|\bmort\b|d[ée]c[èe]s|ex[ée]cution|assassinat|sinking|\bdeath\b|assassination)/i;

/**
 * A real person's walk ends where they died: the year of their death, no step
 * after the one the story tells as a death or a sinking (no captain in New
 * York after the wreck). Pure, for tests.
 */
export function untilDeath<T extends { stop: number }>(steps: T[], stops: PlanStops, who: { died: number | null } | undefined): T[] {
  if (!who || who.died === null) return steps;
  const at = steps.findIndex((st) => {
    const x = stops[st.stop];
    return !!x && histToAstro(x.year) === histToAstro(who.died!) && DEATH.test(`${x.label ?? ''} ${x.name ?? ''}`);
  });
  return at < 0 ? steps : steps.slice(0, at + 1);
}

/**
 * A plan's turning points that hold: at one of its steps (one per step, two
 * at most), through listed stops from that moment on that are none of the
 * walk's later steps, in the order of time; following someone listed (whom
 * the label names, else the number given) where they live then. A real
 * protagonist's turning points always follow someone else: what they did is
 * history. Pure, for tests.
 */
export function buildForks(
  forks: NonNullable<ScenarioItem['forks']>, steps: { stop: number }[], stops: PlanStops, persons: Persons, hero: number | null,
): ScenarioFork[] {
  const out: ScenarioFork[] = [];
  for (const f of forks) {
    const at = f ? steps.findIndex((st) => st.stop === f.at) : -1;
    if (!f || at < 0 || out.some((o) => o.at === f.at) || out.length >= MAX_FORKS) continue;
    const named = namedIn(f.label, persons);
    const given = f.person ?? null;
    const who = named ?? (given !== null && persons[given] ? given : null);
    const person = who !== null && who !== hero ? who : null;
    if (hero !== null && person === null) continue;
    const here = stops[f.at]!;
    const from = histToAstro(here.year);
    // Another way on: none of the walk's own stops, nothing before that moment.
    const walked = new Set(steps.map((st) => st.stop));
    const lives = (i: number) => (person !== null ? aliveIn(persons[person]!, stops[i]!.year, ADULT) : true);
    const after = (s: PlanStops[number]) => histToAstro(s.year) > from || (histToAstro(s.year) === from && (s.when == null || here.when == null || s.when >= here.when));
    const ok = [...new Set(f.stops)].filter((i) => stops[i] && !walked.has(i) && after(stops[i]!) && lives(i));
    const route = orderSteps(ok.map((stop) => ({ stop })), stops).slice(0, FORK_STOPS).map((x) => x.stop);
    if (route.length) out.push({ at: f.at, label: cap(f.label), person, stops: route });
  }
  return out;
}

/**
 * Scenarios that only walk through kept stops, steps in the order of time,
 * at least two of them; the cast among the people alive then (Ballard, born
 * in 1942, is not on the quay in 1912), a real protagonist only at steps of
 * their adult life; one following a real person, then threads of the story
 * (a thing first, then an idea), three at most; their turning points; the AI
 * that planned each. Pure, for tests.
 */
export function buildScenarios(items: (ScenarioItem & { ai?: string })[], stops: PlanStops, persons: Persons): StoryScenario[] {
  const real: StoryScenario[] = [];
  const invented: StoryScenario[] = [];
  const followed = new Set<number>();
  for (const sc of items) {
    // The premise says whom it follows ("Thomas Andrews, architecte…"): small models number the list off by one.
    const person = sc.invented ? null : namedIn(sc.premise, persons) ?? null;
    if (!sc.invented && person === null) continue;
    const isReal = person !== null;
    const seen = new Set<number>();
    const kept = sc.steps.flatMap((st) => {
      if (!st || !stops[st.stop] || seen.has(st.stop)) return [];
      const year = stops[st.stop]!.year;
      if ((isReal && !aliveIn(persons[person]!, year, ADULT)) || (st.text && !textFitsYear(st.text, year))) return [];
      seen.add(st.stop);
      const cast = [...new Set(st.cast.filter((c) => c >= 0 && c < persons.length && aliveIn(persons[c]!, year)))].slice(0, MAX_CAST);
      return [{ stop: st.stop, text: st.text, cast, ...(st.beat ? { beat: cap(st.beat) } : {}) }];
    });
    const steps = untilDeath(orderSteps(kept, stops), stops, isReal ? persons[person] : undefined).slice(0, MAX_STEPS);
    if (steps.length < 2) continue;
    const forks = buildForks(sc.forks ?? [], steps, stops, persons, person);
    const base = { title: sc.title, premise: sc.premise, steps, ...(forks.length ? { forks } : {}), ...(sc.ai ? { ai: sc.ai } : {}) };
    if (isReal) {
      if (followed.has(person) || real.length >= REAL_SCENARIOS) continue;
      followed.add(person);
      real.push({ ...base, person, invented: false });
    } else if (sc.invented) {
      invented.push({ ...base, person: null, invented: true, thread: sc.thread ?? 'thing' });
    }
  }
  // A thing and an idea before a second of either.
  const thing = invented.find((x) => x.thread === 'thing');
  const idea = invented.find((x) => x.thread === 'idea');
  const threads = [thing, idea, ...invented.filter((x) => x !== thing && x !== idea)].filter((x): x is StoryScenario => !!x);
  return [...real, ...threads.slice(0, MAX_SCENARIOS - real.length)];
}

/**
 * A plan too short for its story, filled: the main stops between its first
 * and last moments (where a real protagonist lives then; first those where
 * the article names them, `prefer`), up to `min`
 * steps, all in the story's order (a voyage's ports between its departure
 * and its sinking). Pure, for tests.
 */
export function fillPlan(
  sc: StoryScenario, stops: (PlanStops[number] & { main?: boolean })[], persons: { born: number | null; died: number | null }[], min = MIN_PLAN_STEPS,
  prefer: (stop: number) => boolean = () => false,
): StoryScenario {
  if (sc.steps.length >= min || sc.steps.length === 0) return sc;
  const years = sc.steps.map((st) => histToAstro(stops[st.stop]!.year));
  const [from, to] = [Math.min(...years), Math.max(...years)];
  const hero = sc.person !== null ? persons[sc.person] : undefined;
  const taken = new Set([...sc.steps.map((st) => st.stop), ...(sc.forks ?? []).flatMap((f) => f.stops)]);
  const extra = stops.flatMap((st, i) => {
    const y = histToAstro(st.year);
    return st.main !== false && !taken.has(i) && y >= from && y <= to && (!hero || aliveIn(hero, st.year, ADULT)) ? [{ stop: i, text: '', cast: [] as number[] }] : [];
  }).sort((a, b) => Number(prefer(b.stop)) - Number(prefer(a.stop))).slice(0, min - sc.steps.length);
  // The plan's steps keep their order; one added goes after the planned step the story tells just before it.
  const rank = (st: { stop: number }) => {
    const k = sc.steps.indexOf(st as StoryScenario['steps'][number]);
    if (k >= 0) return k;
    let after = -1;
    sc.steps.forEach((p, j) => { if (p.stop < st.stop) after = j; });
    return after + 0.5 + st.stop / 1e6;
  };
  const steps = untilDeath(orderSteps([...sc.steps, ...extra].sort((a, b) => rank(a) - rank(b)), stops), stops, hero);
  return { ...sc, steps };
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
    return [{ place: s.place, label: s.label, year: s.year, lat: s.lat, lon: s.lon, poi: s.poi, text: st.text, cast: [hero], ...(st.beat ? { beat: cap(st.beat) } : {}) }];
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
    + `The visitor branches off the path « ${from} » at that moment: the premise starts from it (what links this thread to that moment), and the title is new (not « ${from} »).`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The places a step's choices may lead to: of the story's stops not walked
 * yet, those from its moment on, where the protagonist lives then; first the
 * ones `prefer` ranks higher (linked from the step's passage, about a theme
 * shown), then the nearest in time, the main ones first. Pure, for tests.
 */
export function choiceCandidates(
  stops: { year: number; main?: boolean }[], at: number, walked: number[], alive: (year: number) => boolean = () => true, n = STEP_CANDIDATES,
  prefer: (i: number) => number = () => 0,
): number[] {
  const here = stops[at];
  if (!here) return [];
  const y = histToAstro(here.year);
  const taken = new Set([...walked, at]);
  return stops
    .map((s, i) => ({ i, d: histToAstro(s.year) - y, main: s.main !== false, p: prefer(i) }))
    .filter((x) => !taken.has(x.i) && x.d >= -1 && alive(stops[x.i]!.year))
    .sort((a, b) => b.p - a.p || Math.abs(a.d) - Math.abs(b.d) || Number(b.main) - Number(a.main) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.i);
}

/** Is a card about one of the themes shown? People are about none of their own. Pure, for tests. */
export function shownTheme(p: Pick<PoiLite, 'category'>, themes: readonly string[]): boolean {
  return p.category !== 'person' && themes.includes(CATEGORY_THEME[p.category]);
}

/**
 * Cards to offer, those about the themes shown first; the others only when
 * fewer than `min` are (the visitor's view decides, when it can). Pure, for tests.
 */
export function byThemes<T extends Pick<PoiLite, 'category'>>(cards: T[], themes: readonly string[], min = 2): T[] {
  const shown = cards.filter((c) => shownTheme(c, themes));
  return shown.length >= min ? shown : [...shown, ...cards.filter((c) => !shownTheme(c, themes))];
}

/**
 * Known events close to a step, in place and time (`NEAR_KM`, a few years
 * either side; battles, disasters, discoveries…, not towns or institutions),
 * the story's own cards left out, the best known first. Pure, for tests.
 */
export function nearCards(
  pois: PoiLite[], at: { lat: number; lon: number; year: number }, exclude: Set<string>, n = NEAR_MAX, km = NEAR_KM,
): PoiLite[] {
  const y = histToAstro(at.year);
  return pois
    .filter((p) => !exclude.has(p.id) && NEAR_CATEGORIES.has(p.category) && distanceKm(p, at) <= km
      && (p.date_end ?? p.date_start) - p.date_start <= NEAR_SPAN
      && histToAstro(p.date_start) <= y + NEAR_YEARS && histToAstro(p.date_end ?? p.date_start) >= y - NEAR_YEARS)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, n);
}

/** A label naming a card: a word of its title (4 letters or more) in it. Pure, for tests. */
export function namesOverlap(label: string, title: string): boolean {
  const words = new Set(normalize(label).split(' ').filter((w) => w.length >= 4));
  return normalize(title.replace(/\([^)]*\)/g, ' ')).split(' ').some((w) => w.length >= 4 && words.has(w));
}

/**
 * Of a section, what a step reads: around its paragraph (where the section
 * holds it), `chars` at most, at sentence bounds. Pure, for tests.
 */
export function passageAround(section: string, paragraph: string, chars = SECTION_CHARS): string {
  const flat = section.replace(/\s+/g, ' ').trim();
  if (flat.length <= chars) return flat;
  const at = paragraph ? flat.indexOf(paragraph.replace(/\s+/g, ' ').trim().slice(0, 80)) : -1;
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(chars / 3), flat.length - chars));
  const cut = flat.slice(start, start + chars);
  const from = start === 0 ? 0 : cut.search(/[.!?] /) + 2;
  const to = cut.lastIndexOf('. ');
  return cut.slice(Math.max(0, from), to > chars / 2 ? to + 1 : undefined).trim();
}

/** Sentences that tell nothing: hopes, wonders, the heart beating, the air full of tension. */
const FILLER = /(vous vous demandez|vous demandant|espoirs?\b|esp[ée]rance|r[êe]ves?\b|r[êe]vez|excitation|appr[ée]hension|adr[ée]naline|c[œo]e?ur (battant|lourd|serr[ée])|une vie meilleure|nouvelle vie|ce qui vous attend|ce que l'avenir|l'avenir vous|tension (palpable|dans l'air)|l'atmosph[èe]re est|dans l'air\b(?! (froid|glac|frais))|vous ne pouvez vous emp[êe]cher)/i;
const MIN_SENTENCES = 3;

const sentencesOf = (text: string) => text.match(/[^.!?…]+(?:[.!?…]+[»"]?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];

/** A step's text without its filler sentences, as long as enough remain. Pure, for tests. */
export function withoutFiller(text: string): string {
  const kept = sentencesOf(text).filter((s) => !FILLER.test(s));
  return kept.length >= MIN_SENTENCES ? kept.join(' ') : text;
}

/** An encyclopedia speaks to no one and of no path: a sentence telling the reader "vous", or about the next step, is none of it. */
const SECOND_PERSON = /\b(vous|votre|vos)\b/i;
const META = /((prochaine|suivante|derni[èe]re) [ée]tape|cette [ée]tape|ce parcours|ce chemin|le visiteur|le lecteur)/i;

/**
 * A step's paragraphs as shown: without filler nor sentences in the second
 * person (as long as two remain in a paragraph), a long one cut in two at a
 * sentence; MAX_PARAGRAPHS and one at most. Pure, for tests.
 */
export function cleanParagraphs(paragraphs: string[], split = PARAGRAPH_SPLIT_CHARS): string[] {
  return paragraphs.flatMap((p) => {
    const all = sentencesOf(p.replace(/\s+/g, ' ').trim());
    const kept = all.filter((x) => !FILLER.test(x) && !SECOND_PERSON.test(x) && !META.test(x));
    const sentences = kept.length >= 2 || kept.length === all.length ? kept : all;
    if (!sentences.length) return [];
    const text = sentences.join(' ');
    if (text.length <= split || sentences.length < 4) return [text];
    const half = Math.ceil(sentences.length / 2);
    return [sentences.slice(0, half).join(' '), sentences.slice(half).join(' ')];
  }).slice(0, MAX_PARAGRAPHS + 1);
}

/** Indexes of the listed people a text names by their surname. Pure, for tests. */
export function namedAll(text: string, persons: { name: string }[]): number[] {
  const words = new Set(tokens(text));
  return persons.flatMap((p, i) => {
    const t = tokens(p.name);
    const surname = t[t.length - 1];
    return surname && surname.length >= 3 && words.has(surname) ? [i] : [];
  });
}

/** The same, in the order the text first names them: who is there, as the article tells it. Pure, for tests. */
export function namedInOrder(text: string, persons: { name: string }[]): number[] {
  const words = tokens(text);
  const at = (i: number) => {
    const t = tokens(persons[i]!.name);
    return words.indexOf(t[t.length - 1]!);
  };
  return namedAll(text, persons).sort((a, b) => at(a) - at(b) || a - b);
}

/**
 * A plan's turning points as the article tells them: those the AI planned
 * that hold (following no one, or someone the sentences of that step or of
 * the stops it leads to name), then, while fewer than MAX_FORKS, someone a
 * step's sentence names who goes on elsewhere in the article: through the
 * later stops whose sentences name them, off the walk, in their adult life.
 * `texts`: each stop's paragraph. Pure, for tests.
 */
export function wikiForks(sc: Pick<StoryScenario, 'steps' | 'forks' | 'person'>, stops: PlanStops, texts: string[], persons: Persons): ScenarioFork[] {
  const names = (i: number, p: number) => namedAll(texts[i] ?? '', [persons[p]!]).length > 0;
  const out = (sc.forks ?? []).filter((f) => f.person === null || [f.at, ...f.stops].some((i) => names(i, f.person!)));
  const walked = new Set(sc.steps.map((st) => st.stop));
  const used = new Set(out.flatMap((f) => (f.person === null ? [] : [f.person])));
  for (const st of sc.steps) {
    if (out.length >= MAX_FORKS) break;
    const here = stops[st.stop];
    if (!here || out.some((f) => f.at === st.stop)) continue;
    const from = histToAstro(here.year);
    for (const p of namedInOrder(texts[st.stop] ?? '', persons)) {
      if (p === sc.person || used.has(p) || !aliveIn(persons[p]!, here.year, ADULT)) continue;
      // Later: a later year, or the same year a later day; without days, further on in the article.
      const theirs = stops.flatMap((s, i) => {
        const days = s.when != null && here.when != null;
        const later = histToAstro(s.year) > from || (histToAstro(s.year) === from && (days ? s.when! > here.when! : i > st.stop));
        return !walked.has(i) && later && aliveIn(persons[p]!, s.year, ADULT) && names(i, p) ? [i] : [];
      });
      if (!theirs.length) continue;
      const route = untilDeath(orderSteps(theirs.map((stop) => ({ stop })), stops), stops, persons[p]).slice(0, FORK_STOPS).map((x) => x.stop);
      out.push({ at: st.stop, label: `Suivre ${persons[p]!.name}`, person: p, stops: route });
      used.add(p);
      break;
    }
  }
  return out.slice(0, MAX_FORKS);
}

/** A stop of a card's story as a step to walk, its text to be written. Pure, for tests. */
export function stepOf(story: Pick<Story, 'stops'>, i: number): WalkStep | null {
  const s = story.stops[i];
  return s ? { place: s.poi?.title ?? s.name, label: s.label, year: s.year, when: s.when ?? null, lat: s.lat, lon: s.lon, poi: s.poi, text: '', cast: [], stop: i, image: s.image ?? null } : null;
}

/** What a step is asked from: the scenario, the stop, the stops of the whole walk in order. */
export interface StepAsk {
  title: string;
  premise: string;
  hero: string | null;
  invented: boolean;
  stop: number;
  /**
   * The walk's stops in order (the step's own included), after those lived on
   * the walk it forks from: those before it were lived, the one after it is
   * the planned way on, the others are no detours.
   */
  walk: number[];
  /** What is at stake there, as planned. */
  beat: string | null;
  /** The turns the visitor took so far, oldest first. */
  decisions: string[];
  /** Turning points offered at this step: their label and the first stop they lead to. */
  forks: { label: string; stop: number }[];
  /** Asked ahead, for the next step: after whatever the visitor waits for. */
  prefetch: boolean;
}

/** A step of a real person's life to write: the walk, the place, where the walk goes next, the turns taken. */
export interface LifeStepAsk {
  /** Their Wikidata item. */
  person: string;
  title: string;
  premise: string;
  place: string;
  label: string;
  year: number;
  lat: number;
  lon: number;
  /** The place's card, if any. */
  poi: string | null;
  /** The steps read before, as the walk tells them ("1912 Southampton (Port de départ)"). */
  lived: string[];
  next: string | null;
  beat: string | null;
  decisions: string[];
  prefetch: boolean;
}

/** A step of a walk made of cards (a place across the centuries, the world at one moment), written from the card's article. */
export interface CardStepAsk {
  thread: 'place' | 'era';
  title: string;
  premise: string;
  /** The step's part in the walk: its theme ("Religion et croyances"), or what the card is ("Bataille"). */
  label: string;
  lived: string[];
  next: string | null;
  decisions: string[];
  prefetch: boolean;
}

/** A step not written (yet): `ai`, the one at work. */
function noStep(status: StepResponse['status'], ai: string | null = null): StepResponse {
  return { status, text: null, cast: [], choices: [], next: null, facts: [], quote: null, gallery: [], near: [], sources: [], ai };
}

/**
 * Where an article tells a moment of a life: the sentence linking the place
 * (under one of its names), that year first; else one giving that year;
 * null when none. Pure, for tests.
 */
export function momentIn(mentions: Mention[], names: string[], year: number): Mention | null {
  const wanted = new Set(names.filter(Boolean).map((n) => normalize(n.replace(/\([^)]*\)/g, ' '))));
  const there = mentions.filter((m) => wanted.has(normalize(m.target.replace(/\([^)]*\)/g, ' '))));
  const then = (m: Mention) => m.year === year || m.years.includes(year);
  return there.find(then) ?? mentions.find(then) ?? there[0] ?? null;
}

/** The way on as a heading: none when the writer copied the route's line ("1912 · Escale · Cherbourg"). Pure, for tests. */
export function headingOf(next: string | null): string | null {
  return next && !/·|\|/.test(next) && !/^\d{3,4}\b/.test(next.trim()) ? cap(next.trim()) : null;
}

/** Is it a heading of the article (one a link can point to)? Pure, for tests. */
export function headingIn(wikitext: string, heading: string): boolean {
  const want = heading.replace(/\s+/g, ' ').trim().toLowerCase();
  return wikitext.split('\n').some((l) => {
    const h = l.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
    return !!h && h[2]!.replace(/\s+/g, ' ').trim().toLowerCase() === want;
  });
}

/** What a step's text depends on besides its scenario and stop: the way on, the turns offered and taken. Pure, for tests. */
export function stepKey(ask: Pick<StepAsk, 'stop' | 'walk' | 'decisions' | 'forks'>): string {
  const at = ask.walk.lastIndexOf(ask.stop);
  const next = at >= 0 ? ask.walk[at + 1] ?? '' : '';
  return `n${next}|f${ask.forks.map((f) => f.stop).join(',')}|${normalize(ask.decisions.join(' ')).slice(-160)}`;
}

/** The sentence linking each stop and person, kept for the AI: the labels and scenarios are written from them. */
interface Notes { stops: string[]; sections: string[]; people: string[]; paragraphs?: string[] }

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
/** A step written: its paragraphs (blank lines between them), who was there, where it may lead (`stop`: of the story). */
interface StepEntry {
  at: number;
  text: string;
  /** Who is there: the story's people, or someone the step's passage names. */
  cast: StoryPerson[];
  choices: { label: string; stop?: number; card?: PoiLite; person?: StoryPerson }[];
  next?: string | null;
  facts?: string[];
  quote?: StepQuote | null;
  gallery?: StepPicture[];
  near?: PoiLite[];
  sources?: Source[];
  ai?: string;
}

/** What a step is written from: the article's section telling it and the place (its ground), the path around it (its frame). */
interface StepFrame {
  lang: string;
  /** The article telling the moment (the subject's, or the person's), its section's heading and the paragraph about it. */
  page: { title: string; url: string; wikitext: string } | null;
  heading: string | null;
  section: Section | null;
  paragraph: string;
  /** What the step is about, and the article whose pictures fill in when the place has few. */
  subject: string;
  pictures: string | null;
  /** Where its quote comes from. */
  source: Source;
  /** `name`: its article; `title`: as shown. */
  place: { name: string; title: string; label: string; year: number; when: number | null; lat: number; lon: number; image: string | null };
  title: string;
  premise: string;
  hero: StoryPerson | null;
  /** Whom or what the path follows when no one, as told to the writer. */
  follows?: string;
  beat: string | null;
  decisions: string[];
  /** The steps read before, as told to the writer. */
  lived: string[];
  /** Where the planned route goes next, as told; null at its end. */
  next: string | null;
  forks: string[];
  /** Places of the story off the route: `name`, what a detour toward one names. */
  candidates: { stop: number; line: string; name: string }[];
  /** People of the story there then, besides those the passage links to. */
  people: StoryPerson[];
  /** Cards no detour leads to (the subject's, its stops'). */
  exclude: Set<string>;
  /** A place of the story off the route, named as a detour when the writer offers too few. */
  placeLabel?: (stop: number) => string;
}
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

/** Stops with their day, read from their sentence for stories read before days were. */
function dated(s: Pick<StoredStory, 'stops' | 'notes'>): StoryStop[] {
  return s.stops.map((st, i) => (st.when !== undefined ? st : { ...st, when: dayOf(s.notes.stops[i] ?? '', st.year) }));
}

/** Stops as told to the writers: number, year, part, place, ★ when main, the article's sentence. */
function stopLines(stops: StoryStop[], notes: string[] | null): string[] {
  return stops.map((s, i) => `S${i}. ${s.main === false ? '' : '★ '}${s.when != null ? formatDay(s.when) : `year ${s.year}`} · ${s.label} · ${s.poi?.title ?? s.name}${notes?.[i] ? ` — « ${notes[i]!.slice(0, NOTE_CHARS)} »` : ''}`);
}

export class StoryService {
  private cache: Record<string, Entry> = {};
  private scenarioCache: Record<string, ScenariosEntry> = {};
  private personCache: Record<string, PersonEntry> = {};
  private stepCache: Record<string, StepEntry> = {};
  private queue: Job[] = [];
  private running = new Set<string>();
  /** Bones being read (no AI, not queued): one reading per card. */
  private sketching = new Map<string, Promise<void>>();
  private failed = new Map<string, number>();
  /** The links of cards' introductions, by article (kept while the server runs). */
  private linkCache = new Map<string, Promise<CardLink[]>>();
  /** Stories whose stops' cards are being made: shown meanwhile without them. */
  private cardsPending = new WeakSet<(DatedRow | null)[]>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private file: string | null, private router: ProviderRouter) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as {
          stories?: Record<string, Entry>; scenarios?: Record<string, ScenariosEntry>; persons?: Record<string, PersonEntry>; steps?: Record<string, StepEntry>;
        };
        this.cache = raw.stories ?? {};
        this.scenarioCache = raw.scenarios ?? {};
        this.personCache = raw.persons ?? {};
        this.stepCache = raw.steps ?? {};
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
      const draft = this.drafting(key);
      return { status: 'ready', story: await this.resolve(hit.story), draft, ai: draft ? this.router.nextAi('extract') : null };
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
    return { status: old ? 'ready' : 'pending', story: old, draft: !!old, ai: old ? this.router.nextAi('extract') : null };
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
        story: { ...s, stops: labelled.stops, people: persons, labelled: true, provider: answer.ai, notes: { ...s.notes, people: labelled.people.map((p) => p.note) } },
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
        ? { status: 'ready', scenarios: done.scenarios, story: await this.resolve(hit.story), more, ai: more ? this.router.nextAi('write') : null }
        : { status: 'none', scenarios: [] };
    }
    if (!this.router.canRun('write')) return { status: 'no-ai', scenarios: [] };
    this.queueScenarios(poi, ctx, key, hit);
    return { status: 'pending', scenarios: [], ai: this.router.nextAi('write') };
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
    return { status: 'pending', walk: null, ai: this.router.nextAi('write') };
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
    return { status: 'pending', walk: null, ai: this.router.nextAi('write') };
  }

  /**
   * A step, written when the visitor gets there, as a short section of an
   * encyclopedia: from the section of the subject's article telling that
   * moment, the article detailing it and the place's own; with the people
   * the section names, its pictures and their captions, a few facts and a
   * sentence word for word; and the turns the story may take (other places of
   * the story, subjects the section links to or close by, someone met), for
   * the visitor's themes. Written once per scenario and view, then kept.
   */
  async step(poi: Poi, ask: StepAsk, ctx: ScenarioContext): Promise<StepResponse> {
    const storyKey = this.key(poi);
    let hit = this.cache[storyKey];
    if (!hit || hit.v !== STORY_VERSION) {
      await this.get(poi);
      hit = this.cache[storyKey];
      if (!hit || hit.v !== STORY_VERSION) return noStep('pending', this.router.nextAi('write'));
    }
    const stored = hit.story;
    if (!stored || !stored.stops[ask.stop]) return noStep('none');
    const key = `step${STEP_VERSION}|${storyKey}|${hit.at}|${normalize(ask.title)}|${ask.stop}|${stepKey(ask)}|${contextKey(ctx)}`;
    const done = this.stepCache[key];
    if (done) return this.stepOut(done, await this.resolve(stored));
    return this.queueStep(key, ask.prefetch, () => this.writeStep(poi, stored, ask, ctx));
  }

  /**
   * A step of a real person's life, written when the visitor gets there like
   * a card's: from the section of their article telling that moment (where
   * it links the place, else gives the year). Written once per walk and view.
   */
  async lifeStep(ask: LifeStepAsk, ctx: ScenarioContext): Promise<StepResponse> {
    const key = `life${STEP_VERSION}|${ask.person}|${normalize(ask.title)}|${normalize(ask.place)}|${ask.year}|${normalize(ask.next ?? '')}|${normalize(ask.decisions.join(' ')).slice(-160)}|${contextKey(ctx)}`;
    const done = this.stepCache[key];
    if (done) return this.stepOut(done, null);
    return this.queueStep(key, ask.prefetch, () => this.writeLifeStep(ask, ctx));
  }

  /**
   * A step of a walk made of cards, written when the visitor gets there like
   * the others: from the card's own article (its introduction, its pictures,
   * who it names). Written once per walk and view.
   */
  async cardStep(poi: Poi, ask: CardStepAsk, ctx: ScenarioContext): Promise<StepResponse> {
    if (!poi.wiki_title) return noStep('none');
    const key = `card${STEP_VERSION}|${poi.id}|${normalize(ask.title)}|${normalize(ask.next ?? '')}|${normalize(ask.decisions.join(' ')).slice(-160)}|${contextKey(ctx)}`;
    const done = this.stepCache[key];
    if (done) return this.stepOut(done, null);
    return this.queueStep(key, ask.prefetch, () => this.writeCardStep(poi, ask, ctx));
  }

  private queueStep(key: string, later: boolean, write: () => Promise<StepEntry>): StepResponse {
    if ((this.failed.get(key) ?? 0) > Date.now()) return noStep('none');
    if (!this.router.canRun('write')) return noStep('no-ai');
    this.enqueue(key, async () => {
      this.stepCache[key] = await write();
      const keys = Object.keys(this.stepCache);
      if (keys.length > STEPS_KEEP) for (const old of keys.slice(0, keys.length - STEPS_KEEP)) delete this.stepCache[old];
    }, later);
    return noStep('pending', this.router.nextAi('write'));
  }

  private stepOut(e: StepEntry, story: Story | null): StepResponse {
    return {
      status: 'ready',
      text: e.text,
      cast: e.cast,
      next: e.next ?? null,
      choices: e.choices.flatMap((c): StepChoice[] => {
        if (c.card) return [{ label: c.label, poi: c.card }];
        if (c.person) return [{ label: c.label, person: c.person }];
        const step = c.stop === undefined || !story ? null : stepOf(story, c.stop);
        return step ? [{ label: c.label, step }] : [];
      }),
      facts: e.facts ?? [],
      quote: e.quote ?? null,
      gallery: e.gallery ?? [],
      near: e.near ?? [],
      sources: e.sources ?? [],
      ai: e.ai ?? null,
    };
  }

  /** Cards close by at a step's moment, from those already known, the best known first. */
  private async nearAt(s: { lat: number; lon: number; year: number }, exclude: Set<string>): Promise<PoiLite[]> {
    const y = histToAstro(s.year);
    const known = await this.store.queryTimeRange(y - NEAR_YEARS, y + NEAR_YEARS, NEAR_LOOKUP).catch(() => [] as PoiLite[]);
    const found = nearCards(known, s, exclude);
    if (found.length >= 2) return found;
    // Few known: Wikidata's dated items around the place, made cards, in the time a step allows.
    const asked = (async () => {
      const rows = await wikidata.queryAround(s.lat, s.lon, NEAR_WIKIDATA_KM, s.year - NEAR_YEARS, s.year + NEAR_YEARS + 1, 40);
      await this.store.upsertPois(await buildPois(rows, this.store));
      return (await this.store.getPoisByQids(rows.map((r) => r.qid))).map(toLite);
    })().catch(() => [] as PoiLite[]);
    const late = new Promise<PoiLite[]>((r) => setTimeout(() => r([]), NEAR_WAIT_MS).unref());
    const more = await Promise.race([asked, late]);
    return nearCards([...found, ...more.filter((p) => !found.some((f) => f.id === p.id))], s, exclude);
  }

  /**
   * The pictures of a step, with their captions: those of the section
   * telling this moment (the liner leaving Southampton, captioned as the
   * article captions it), then the place's article's, then the subject's
   * when still few (captioned by their Commons description).
   */
  private async galleryOf(lang: string, name: string, image: string | null, subject: string | null, section: Section | null, detailed: string | null): Promise<StepPicture[]> {
    const none = () => [] as wikipedia.WikiPicture[];
    const [moment, told, own] = await Promise.all([
      wikipedia.fileThumbs(lang, (section?.files ?? []).slice(0, 20)).catch(none),
      detailed ? wikipedia.pageImages(lang, detailed, GALLERY_MAX).catch(none) : Promise.resolve(none()),
      wikipedia.pageImages(lang, name, GALLERY_MAX).catch(none),
    ]);
    const more = moment.length + told.length + own.length < 3 && subject ? await wikipedia.pageImages(lang, subject, GALLERY_MAX).catch(none) : [];
    const file = (u: string) => decodeURIComponent(u.split('/').at(-1) ?? u).replace(/^\d+px-/, '');
    const seen = new Set(image ? [file(image)] : []);
    // The moment's own pictures first, then the article detailing it; the place's then shows a few (its airport and its walls tell little of it).
    const known = moment.length + told.length;
    return [...moment, ...told.slice(0, 4), ...own.slice(0, known >= 3 ? 1 : known ? 2 : GALLERY_MAX), ...more]
      .filter((p) => !seen.has(file(p.url)) && seen.add(file(p.url)))
      .slice(0, GALLERY_MAX)
      .map((p) => ({ src: p.url, caption: section?.captions[p.file] ?? p.description }));
  }

  /** What a passage links to, in the order of its text: the people (Wikidata humans alive that year), and the cards already known. */
  private async linkedOf(lang: string, links: string[], year: number): Promise<{ people: StoryPerson[]; cards: PoiLite[] }> {
    const asked = links.slice(0, SECTION_LINKS);
    const infos = await wikipedia.pagesInfo(lang, asked);
    const qids = [...new Set([...infos.values()].flatMap((i) => (i.qid ? [i.qid] : [])))];
    // People have no coordinates.
    const placeless = [...new Set([...infos.values()].flatMap((i) => (i.qid && i.lat === null ? [i.qid] : [])))];
    const [hits, known] = await Promise.all([
      people.peopleByQids(placeless).catch(() => []),
      this.store.getPoisByQids(qids).catch(() => [] as Poi[]),
    ]);
    const byQid = new Map(known.map((p) => [p.wikidata_qid, p]));
    const seen = new Set<string>();
    const persons = asked.flatMap((l) => {
      const h = hits.find((x) => x.qid === infos.get(l)?.qid);
      if (!h || seen.has(h.qid) || /^Q\d+$/.test(h.name) || !aliveIn(h, year)) return [];
      seen.add(h.qid);
      return [{ qid: h.qid, name: h.name, role: cap((h.description ?? 'Personnage de l’histoire').slice(0, 60)), born: h.born, died: h.died, image: h.image }];
    });
    // A country is no detour: too wide to go to.
    const cards = asked.flatMap((l) => {
      const c = byQid.get(infos.get(l)?.qid ?? '');
      if (!c || c.category === 'person' || c.category === 'polity' || seen.has(c.id)) return [];
      seen.add(c.id);
      return [toLite(c)];
    });
    return { people: persons, cards };
  }

  private async writeStep(poi: Poi, stored: StoredStory, ask: StepAsk, ctx: ScenarioContext): Promise<StepEntry> {
    const story = await this.resolve(stored);
    const s = story.stops[ask.stop]!;
    const lang = poi.wiki_lang ?? 'fr';
    const hero = ask.hero ? story.people.find((p) => p.qid === ask.hero) ?? null : null;
    const at = ask.walk.lastIndexOf(ask.stop);
    const lived = (at >= 0 ? ask.walk.slice(0, at) : ask.walk).flatMap((i) => (story.stops[i] ? [story.stops[i]!] : []));
    const next = at >= 0 && ask.walk[at + 1] !== undefined ? story.stops[ask.walk[at + 1]!] ?? null : null;
    const forks = ask.forks.flatMap((f) => (story.stops[f.stop] ? [{ label: f.label, to: story.stops[f.stop]! }] : []));
    const paragraph = stored.notes.paragraphs?.[ask.stop] || (stored.notes.stops[ask.stop] ?? '');
    // The whole section telling this moment, not only the paragraph linking the place: its people, its pictures, its detailed article.
    const page = await wikipedia.pageWikitext(lang, poi.wiki_title!).catch(() => null);
    const heading = stored.notes.sections[ask.stop] ?? null;
    const section = page ? sectionOf(page.wikitext, heading) : null;
    // Detours go off the route (neither the walk nor its turning points): the places the section links to first, then those about a theme shown.
    const linked = new Set((section?.links ?? []).map((l) => normalize(l)));
    const prefer = (i: number) => {
      const x = story.stops[i]!;
      return (linked.has(normalize(x.name)) ? 2 : 0) + (x.poi && shownTheme(x.poi, ctx.themes) ? 1 : 0);
    };
    const candidates = choiceCandidates(story.stops, ask.stop, [...ask.walk, ...ask.forks.map((f) => f.stop)], hero ? (y) => aliveIn(hero, y, ADULT) : undefined, STEP_CANDIDATES, prefer);
    const note = (i: number) => (stored.notes.stops[i] ?? '').slice(0, NOTE_CHARS);
    const when = (x: StoryStop) => (x.when != null ? formatDay(x.when) : String(x.year));
    const where = (x: StoryStop) => `${when(x)} · ${x.label} · ${x.poi?.title ?? x.name}`;
    return this.compose({
      lang, page, heading, section, paragraph, subject: poi.title, pictures: poi.wiki_title, source: stored.source,
      place: { name: s.name, title: s.poi?.title ?? s.name, label: s.label, year: s.year, when: s.when ?? null, lat: s.lat, lon: s.lon, image: s.image ?? null },
      title: ask.title, premise: ask.premise, hero, beat: ask.beat, decisions: ask.decisions,
      lived: lived.map((x) => `${when(x)} ${x.poi?.title ?? x.name} (${x.label})`),
      next: next ? `${where(next)} — « ${note(ask.walk[at + 1]!)} »` : null,
      forks: forks.map((f, k) => `F${k}. « ${f.label} » → ${where(f.to)}`),
      candidates: candidates.map((i) => ({ stop: i, line: `${where(story.stops[i]!)} — « ${note(i)} »`, name: `${story.stops[i]!.poi?.title ?? story.stops[i]!.name} ${story.stops[i]!.name}` })),
      people: story.people.filter((p) => p.qid === hero?.qid || aliveIn(p, s.year)),
      exclude: new Set([poi.id, ...story.stops.flatMap((x) => (x.poi ? [x.poi.id] : []))]),
      placeLabel: (i) => `${story.stops[i]!.label} : ${story.stops[i]!.poi?.title ?? story.stops[i]!.name}`,
    }, ctx);
  }

  private async writeLifeStep(ask: LifeStepAsk, ctx: ScenarioContext): Promise<StepEntry> {
    const [[found], info, card] = await Promise.all([
      people.peopleByQids([ask.person]),
      wikidata.queryEntityInfo([ask.person]).then((m) => m.get(ask.person)),
      ask.poi ? this.store.getPoi(ask.poi).catch(() => null) : Promise.resolve(null),
    ]);
    const lang = info?.frTitle ? 'fr' : 'en';
    const title = info?.frTitle ?? info?.enTitle;
    const page = title ? await wikipedia.pageWikitext(lang, title) : null;
    if (!found || !page) throw new Error('no article for this life');
    const hero: StoryPerson = { qid: found.qid, name: found.name, role: cap((found.description ?? '').slice(0, 60)), born: found.born, died: found.died, image: found.image };
    // Where the article tells this moment: the sentence linking the place (that year first), else one giving the year.
    const m = momentIn(mentionsOf(page.wikitext), [ask.place, card?.title ?? '', card?.wiki_title ?? ''], ask.year);
    const heading = m?.path[0] ?? null;
    const section = sectionOf(page.wikitext, heading);
    return this.compose({
      lang, page, heading, section, paragraph: m?.paragraph ?? '', subject: hero.name, pictures: page.title,
      source: { url: page.url, title: `Wikipédia : ${page.title}`, kind: 'wikipedia' },
      place: { name: card?.wiki_title ?? ask.place, title: card?.title ?? ask.place, label: ask.label, year: ask.year, when: null, lat: ask.lat, lon: ask.lon, image: null },
      title: ask.title, premise: ask.premise, hero, beat: ask.beat, decisions: ask.decisions,
      lived: ask.lived, next: ask.next, forks: [], candidates: [], people: [hero],
      exclude: new Set(card ? [card.id] : []),
    }, ctx);
  }

  private async writeCardStep(poi: Poi, ask: CardStepAsk, ctx: ScenarioContext): Promise<StepEntry> {
    const lang = poi.wiki_lang ?? 'fr';
    const page = await wikipedia.pageWikitext(lang, poi.wiki_title!);
    if (!page) throw new Error('no article for this card');
    // Its introduction tells what it is and when.
    const section = sectionOf(page.wikitext, null);
    return this.compose({
      lang, page, heading: null, section, paragraph: poi.summary || section.text.slice(0, CARD_LEAD_CHARS), subject: poi.title, pictures: page.title,
      source: { url: page.url, title: `Wikipédia : ${page.title}`, kind: 'wikipedia' },
      place: { name: poi.wiki_title!, title: poi.title, label: ask.label, year: poi.date_start, when: null, lat: poi.lat, lon: poi.lon, image: poi.image_url ?? null },
      title: ask.title, premise: ask.premise, hero: null, beat: null, decisions: ask.decisions,
      follows: ask.thread === 'place'
        ? 'It stays at one place across the centuries: each step is another moment of the same place, told from its own article.'
        : `It looks at one moment across the world, one theme per step: this step's theme is « ${ask.label} ».`,
      lived: ask.lived, next: ask.next, forks: [], candidates: [], people: [], exclude: new Set([poi.id]),
    }, ctx);
  }

  /**
   * A step written from its ground (the article's section about it, the place)
   * and its frame (the path around it): the AI writes its paragraphs from
   * them; who was there and where it may lead are read from the section.
   */
  private async compose(f: StepFrame, ctx: ScenarioContext): Promise<StepEntry> {
    const s = f.place;
    const passage = (f.section && passageAround(f.section.text, f.paragraph)) || f.paragraph;
    const detailedTitle = f.section?.detailed.find((t) => normalize(t) !== normalize(f.page?.title ?? '')) ?? null;
    const [summary, gallery, near, linked, detailed] = await Promise.all([
      wikipedia.pageSummary(f.lang, s.name).catch(() => null),
      this.galleryOf(f.lang, s.name, s.image, f.pictures, f.section, detailedTitle),
      this.nearAt(s, f.exclude),
      this.linkedOf(f.lang, f.section?.links ?? [], s.year).catch(() => ({ people: [] as StoryPerson[], cards: [] as PoiLite[] })),
      detailedTitle ? wikipedia.pageText(f.lang, detailedTitle, DETAILED_CHARS).catch(() => null) : Promise.resolve(null),
    ]);
    // Those the passage names first, then the section's, then the story's people of that time; the protagonist always.
    const all = [...linked.people, ...f.people].filter((p, i, a) => a.findIndex((q) => q.qid === p.qid) === i);
    const inPassage = new Set(namedAll(passage, all));
    const persons = all.map((p, i) => ({ p, i })).sort((a, b) => Number(inPassage.has(b.i)) - Number(inPassage.has(a.i)) || a.i - b.i)
      .map((x) => x.p).slice(0, STEP_PEOPLE);
    const named = new Set(namedAll(passage, persons).map((i) => persons[i]!.qid));
    // Other subjects: those the section links to, then those close by at that moment; about the themes shown, when there are some.
    const linkedCards = byThemes(linked.cards.filter((c) => !f.exclude.has(c.id)), ctx.themes).slice(0, LINKED_MAX);
    const nearShown = byThemes(near.filter((c) => !linkedCards.some((l) => l.id === c.id)), ctx.themes);
    const others = [...linkedCards, ...nearShown].slice(0, LINKED_MAX + NEAR_MAX);
    const date = (c: PoiLite) => `${c.date_start}${c.date_end && c.date_end !== c.date_start ? `–${c.date_end}` : ''}`;
    const life = (p: StoryPerson) => `(${p.born ?? '?'}–${p.died ?? ''})`;
    const user = [
      `Subject: « ${f.subject} ».`,
      describeContext(ctx),
      '',
      `Path: « ${f.title} ». ${f.premise}`,
      f.hero ? `It follows ${f.hero.name} ${life(f.hero)}, ${f.hero.role}.` : f.follows ?? 'It follows no one in particular: a thread of the story, from the angle above.',
      f.lived.length ? `Steps already read: ${f.lived.join(' → ')}.` : 'This is the first step.',
      f.decisions.length ? `Turns the visitor took, oldest first: ${f.decisions.map((d) => `« ${d} »`).join(' → ')}. The last one led here.` : 'No turn taken yet.',
      '',
      `This step: ${s.when != null ? formatDay(s.when) : s.year} · ${s.label} · ${s.title}.`,
      f.beat ? `Its heading: ${f.beat}.` : '',
      `The passage of the article « ${f.page?.title ?? f.subject} » about it: « ${passage} »`,
      detailed ? `The article detailing that part (« ${detailed.title} »), its start: « ${detailed.text} »` : '',
      summary ? `The place's own article (« ${summary.title} »), summary: « ${summary.extract.slice(0, SUMMARY_CHARS)} »` : '',
      '',
      persons.length ? 'People (★: named in the passage):' : 'People: none listed.',
      ...persons.map((p, i) => `P${i}. ${named.has(p.qid) ? '★ ' : ''}${p.name} ${life(p)}, ${p.role}`),
      '',
      f.next ? `The planned route goes on to: ${f.next}` : 'The planned route ends here: the last paragraph says what came of it.',
      ...(f.forks.length ? ['Turning points offered here (the text names where each leads):', ...f.forks] : []),
      '',
      f.candidates.length ? 'Places of the story off the route (a detour of one step):' : '',
      ...f.candidates.map((c, k) => `C${k}. ${c.line}`),
      others.length ? 'Other subjects (a choice may leave for one, as a detour):' : '',
      ...others.map((c, k) => `K${k}. ${c.title} (${date(c)}) — ${linkedCards.includes(c) ? 'linked from the passage' : 'close by at the same moment'}`),
    ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
    const answer = await this.router.completeJson('write', STEP_SYSTEM, user, (v) => StepAnswer.parse(v), 6000);
    if (!answer) throw new Error('no AI available');
    const v = answer.value;
    const paragraphs = cleanParagraphs(v.paragraphs);
    const quote = v.quote?.replace(/^[\s«"“„]+|[\s»"”]+$/g, '') || null;
    // Who was there, as the article tells it: the person followed, those the paragraph names, then the passage, then
    // those the writer placed whom the sources name (never someone only because listed).
    const told = new Set(namedAll(`${passage} ${detailed?.text ?? ''}`, persons));
    const heroAt = persons.findIndex((p) => p.qid === f.hero?.qid);
    const cast = [...new Set([
      ...(heroAt >= 0 ? [heroAt] : []),
      ...namedInOrder(f.paragraph, persons),
      ...namedInOrder(passage, persons),
      ...v.cast.filter((c) => told.has(c)),
      ...namedAll(paragraphs.join(' '), persons).filter((c) => told.has(c)),
    ])].filter((c) => persons[c] && aliveIn(persons[c]!, s.year)).slice(0, STEP_CAST).map((c) => persons[c]!);
    const seen = new Set<string>();
    const choices = v.choices.flatMap((c): StepEntry['choices'] => {
      if (!c) return [];
      const place = c.to.kind === 'C' ? f.candidates[c.to.i] : undefined;
      // A detour goes where its label says: one naming another place is no way there.
      if (place && !namesOverlap(c.label, place.name)) return [];
      const stop = place?.stop;
      const card = c.to.kind === 'K' ? others[c.to.i] : undefined;
      const person = c.to.kind === 'P' ? persons[c.to.i] : undefined;
      if (card && !namesOverlap(c.label, card.title)) return [];
      // Someone met here, other than the protagonist, whom the label names.
      if (person && (person.qid === f.hero?.qid || !told.has(c.to.i) || !namesOverlap(c.label, person.name))) return [];
      const id = stop !== undefined ? `C${stop}` : card ? `K${card.id}` : person ? `P${person.qid}` : null;
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [card ? { label: cap(c.label), card } : person ? { label: cap(c.label), person } : { label: cap(c.label), stop }];
    }).slice(0, MAX_DETOURS);
    // Too few: the article's own, someone its paragraph names, a subject its section links to.
    const met = namedInOrder(`${f.paragraph} ${passage}`, persons).map((i) => persons[i]!).find((p) => p.qid !== f.hero?.qid && !seen.has(`P${p.qid}`));
    if (choices.length < 2 && met) choices.push({ label: `Suivre ${met.name}`, person: met });
    const subject = linkedCards.find((c) => !seen.has(`K${c.id}`));
    if (choices.length < 2 && subject) choices.push({ label: subject.title, card: subject });
    const off = f.candidates.find((c) => !seen.has(`C${c.stop}`));
    if (choices.length < 2 && off && f.placeLabel) choices.push({ label: f.placeLabel(off.stop), stop: off.stop });
    const sources: Source[] = [];
    if (f.page) {
      const anchor = f.heading && headingIn(f.page.wikitext, f.heading) ? f.heading : null;
      sources.push({ url: `${f.page.url}${anchor ? `#${encodeURIComponent(anchor.replace(/ /g, '_'))}` : ''}`, title: `Wikipédia : ${f.page.title}${anchor ? ` § ${anchor}` : ''}`, kind: 'wikipedia' });
    }
    if (detailed) sources.push({ url: detailed.url, title: `Wikipédia : ${detailed.title}`, kind: 'wikipedia' });
    if (summary && !sources.some((x) => x.url === summary.url)) sources.push({ url: summary.url, title: `Wikipédia : ${summary.title}`, kind: 'wikipedia' });
    return {
      at: Date.now(),
      text: paragraphs.join('\n\n'),
      next: f.next ? headingOf(v.next) : null,
      cast,
      choices,
      facts: v.facts.slice(0, MAX_FACTS),
      // Word for word, or nothing: a quote the article does not hold is no quote.
      quote: quote && (grounded(passage, quote) || grounded(f.paragraph, quote)) ? { text: quote, source: f.source } : null,
      gallery,
      near: nearShown.slice(0, NEAR_MAX),
      sources,
      ai: answer.ai,
    };
  }

  /**
   * The links of an article's introduction made something to act on: the
   * people (Wikidata humans), the cards already known, the places with
   * coordinates. Read once per article, no AI.
   */
  links(lang: string, title: string): Promise<CardLink[]> {
    const key = `${lang}|${title}`;
    let run = this.linkCache.get(key);
    if (!run) {
      run = this.readLinks(lang, title).catch((e) => {
        this.linkCache.delete(key);
        throw e;
      });
      this.linkCache.set(key, run);
      if (this.linkCache.size > LINKS_KEEP) this.linkCache.delete(this.linkCache.keys().next().value!);
    }
    return run;
  }

  private async readLinks(lang: string, title: string): Promise<CardLink[]> {
    const page = await wikipedia.pageWikitext(lang, title);
    if (!page) return [];
    const links = leadLinks(page.wikitext).slice(0, MAX_LINKS_LEAD);
    const infos = await wikipedia.pagesInfo(lang, links.map((l) => l.target));
    const qids = [...new Set(links.flatMap((l) => infos.get(l.target)?.qid ?? []))];
    // People have no coordinates.
    const placeless = [...new Set([...infos.values()].flatMap((i) => (i.qid && i.lat === null ? [i.qid] : [])))];
    const [persons, cards] = await Promise.all([
      people.peopleByQids(placeless).catch(() => []),
      this.store.getPoisByQids(qids).catch(() => [] as Poi[]),
    ]);
    return links.flatMap((l): CardLink[] => {
      const info = infos.get(l.target);
      if (!info?.qid) return [];
      const url = wikipedia.articleUrl(lang, info.title);
      const h = persons.find((p) => p.qid === info.qid);
      if (h && !/^Q\d+$/.test(h.name)) {
        return [{ label: l.label, url, kind: 'person', person: { qid: h.qid, name: h.name, role: h.description ?? '', born: h.born, died: h.died, image: h.image, description: h.description } }];
      }
      const card = cards.find((p) => p.wikidata_qid === info.qid);
      if (card) return [{ label: l.label, url, kind: 'card', poi: toLite(card) }];
      if (info.lat !== null && info.lon !== null && isPlace(info)) return [{ label: l.label, url, kind: 'place', lat: info.lat, lon: info.lon }];
      return [];
    });
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
      `${detourAsk(year, from)} Follow no one in particular but a THREAD of that story (person = null, invented = true).`,
    ].join('\n');
    // A small model sometimes answers off the list: once more before giving up for a while.
    for (let tries = 0; tries < 2; tries++) {
      const answer = await this.router.completeJson('write', SCENARIOS_SYSTEM, user, (v) => ExtractedScenarios.parse(v), 3000);
      if (!answer) throw new Error('no AI available');
      const items = answer.value.scenarios.filter((x): x is ScenarioItem => !!x).map((x) => ({ ...x, invented: true, ai: answer.ai }));
      // A detour is short and goes back: no turning points of its own.
      const sc = buildScenarios(items, sub.stops, sub.people).find((x) => x.invented);
      if (sc) delete sc.forks;
      if (sc) {
        const walk = walkOf(toLite(poi), sub, { ...sc, steps: sc.steps.slice(0, DETOUR_MAX) });
        const steps = walk.steps.map((st) => ({ ...st, stop: st.stop === undefined ? undefined : near[st.stop]?.i }));
        return { ...walk, steps, id: `${walk.id}|détour|${year}`, ai: answer.ai };
      }
    }
    throw new Error('no usable detour');
  }

  private enqueue(key: string, run: () => Promise<void>, later = false): void {
    if (this.running.has(key) || (this.failed.get(key) ?? 0) > Date.now()) return;
    // The latest asked comes first: the visitor has moved on from the others. Asked ahead: last.
    if (later && this.queue.some((j) => j.key === key)) return;
    const rest = this.queue.filter((j) => j.key !== key);
    this.queue = (later ? [...rest, { key, run }] : [{ key, run }, ...rest]).slice(0, QUEUE_MAX);
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
        phase: phaseOf({ ...m, year }, subject), name: info.title, label: labelOf(m), year, when: dayOf(m.sentence, year),
        lat: Math.round(info.lat! * 1e4) / 1e4, lon: Math.round(info.lon! * 1e4) / 1e4, poi: card ? toLite(card) : null, main: rank < MAIN_STOPS, image: info.image,
      };
      return { stop, row: rowOf.get(info.qid!) ?? null, note: m.sentence, paragraph: m.paragraph, section: m.field ?? m.path[0] ?? 'Introduction', told: m.order };
    }).sort((a, b) => order(a.stop.phase) - order(b.stop.phase) || histToAstro(a.stop.year) - histToAstro(b.stop.year) || a.told - b.told);

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
      notes: { stops: built.map((b) => b.note), sections: built.map((b) => b.section), people: persons.map((x) => x.note), paragraphs: built.map((b) => b.paragraph) },
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
    const stops = dated(story);
    const article = await wikipedia.pageText(poi.wiki_lang ?? 'fr', poi.wiki_title!, SCENARIO_ARTICLE_CHARS).catch(() => null);
    const user = [
      `Subject: « ${poi.title} ».`,
      describeContext(ctx),
      '',
      'Stops:',
      ...stopLines(stops, story.notes.stops),
      '',
      story.people.length ? 'People:' : 'People: none listed.',
      // Lifetimes, so a step is not put before someone's birth (Ballard at the 1912 sinking).
      ...story.people.map((p, i) => `P${i}. ${p.name} (${p.born ?? '?'}–${p.died ?? ''}), ${p.role}${story.notes.people[i] ? ` — « ${story.notes.people[i]!.slice(0, NOTE_CHARS)} »` : ''}`),
      ...(article ? ['', `Start of the article « ${article.title} » :`, '', article.text] : []),
    ].join('\n');
    const ask = async (extra: string) => {
      const answer = await this.router.completeJson('write', SCENARIOS_SYSTEM, extra ? `${user}\n\n${extra}` : user, (v) => ExtractedScenarios.parse(v), 3000);
      if (!answer) throw new Error('no AI available');
      return answer.value.scenarios.filter((x): x is ScenarioItem => !!x).map((x) => ({ ...x, ai: answer.ai }));
    };
    // One scenario per request: three at once take a small model past its time limit, or it writes only one.
    // The real person and the thing together, then the idea.
    const real = (taken: string) => ask(`This time write exactly ONE scenario, following a REAL person of the list${taken ? ` other than ${taken}` : ''} (invented = false, thread = null).`);
    const thread = (kind: 'thing' | 'idea') => ask(`This time write exactly ONE scenario, following ${kind === 'thing' ? 'a THING of the story' : 'an IDEA'} (person = null, invented = true, thread = "${kind}").`)
      .then((xs) => xs.map((x) => ({ ...x, invented: true, thread: kind })));
    const items: (ScenarioItem & { ai?: string })[] = [];
    const wantReal = Math.min(REAL_SCENARIOS, story.people.length);
    const settled = await Promise.allSettled([wantReal ? real('') : thread('idea'), thread('thing')]);
    for (const r of settled) if (r.status === 'fulfilled') items.push(...r.value);
    // A real person's plan is filled first with the stops whose paragraph names them.
    const names = (sc: StoryScenario) => (i: number) => {
      const who = sc.person !== null ? story.people[sc.person]?.name.split(' ').at(-1) : undefined;
      return !!who && (story.notes.paragraphs?.[i] ?? story.notes.stops[i] ?? '').includes(who);
    };
    const texts = stops.map((_, i) => story.notes.paragraphs?.[i] || story.notes.stops[i] || '');
    const build = () => buildScenarios(items, stops, story.people).map((sc) => {
      const full = fillPlan(sc, stops, story.people, MIN_PLAN_STEPS, names(sc));
      const forks = wikiForks(full, stops, texts, story.people);
      const { forks: _, ...rest } = full;
      return forks.length ? { ...rest, forks } : rest;
    });
    if (build().length) first(build());
    // Whatever is still missing (the idea, a failed request), alone, a few times at most.
    for (let tries = 0; tries < MAX_SCENARIOS; tries++) {
      const built = build();
      const followed = built.filter((x) => !x.invented);
      const has = (k: 'thing' | 'idea') => built.some((x) => x.thread === k);
      const next = followed.length < wantReal ? real(followed.map((x) => `P${x.person}`).join(', '))
        : built.length >= MAX_SCENARIOS ? null
        : !has('thing') ? thread('thing') : !has('idea') ? thread('idea') : thread('thing');
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
      if (walk) return { ...walk, ai: answer.ai };
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
      stops: dated(s).map((stop, i) => {
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
        writeFileSync(this.file!, JSON.stringify({ stories: this.cache, scenarios: this.scenarioCache, persons: this.personCache, steps: this.stepCache }));
      } catch (e) {
        console.warn('[story] could not save cache:', (e as Error).message);
      }
    }, 2000);
    this.saveTimer.unref();
  }
}
