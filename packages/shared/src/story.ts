import type { PoiLite, Source } from './poi.ts';
import type { Theme } from './themes.ts';
import { formatDay, formatYear } from './years.ts';

// The story of a subject (brief §4.5, beyond the five doors): an AI reads the
// card's Wikipedia article for the places and moments of its story (where
// the Titanic was built, the ports it left, where it sank, where the dead
// were buried), what it led to (the wars that followed the attacks on the
// World Trade Center), the people who lived it, and a few walks through it
// in someone's shoes. Places and moments quote the article; people are
// Wikidata humans; scenarios are written by the AI over those checked stops,
// for the way the visitor looks at the world (lens, themes) and the path that
// led them to the card: two follow real people, the last an invented one.

export const STORY_PHASES = ['before', 'during', 'after'] as const;
export type StoryPhase = (typeof STORY_PHASES)[number];

export const STORY_PHASE_LABELS: Record<StoryPhase, string> = {
  before: 'Aux origines',
  during: 'Les lieux de l’histoire',
  after: 'Ce que ça a engendré',
};

export interface StoryStop {
  phase: StoryPhase;
  /** As the article names it, e.g. "Southampton". */
  name: string;
  /** Its part in the story, in French, e.g. "Port de départ". */
  label: string;
  /** Year of that moment of the story (not the place's own date). */
  year: number;
  /** The day of that moment, as a decimal year, when its sentence gives it ("10 avril 1912"). */
  when?: number | null;
  lat: number;
  lon: number;
  /** The Wikidata item as a card, when it has one fitting the story. */
  poi: PoiLite | null;
  /** One of the story's own places (shown first); false for one its article only cites. Absent: main. */
  main?: boolean;
  /** Its article's picture. */
  image?: string | null;
}

export interface StoryPerson {
  qid: string;
  name: string;
  /** Their part in the story, in French, e.g. "Commandant du navire". */
  role: string;
  born: number | null;
  died: number | null;
  image: string | null;
}

export interface StoryScenario {
  title: string;
  /** Whose shoes, e.g. "Vous êtes un émigrant irlandais embarqué en troisième classe". */
  premise: string;
  /**
   * Index in `stops`, what happens there for that character, and the key
   * people present (indexes in `people`), placed on the map at that step;
   * `beat`: what is at stake for the character there, in a line.
   */
  steps: { stop: number; text: string; cast: number[]; beat?: string }[];
  /** Index in `people` when the scenario follows one of them. */
  person: number | null;
  /** An invented character (a typical person of the time), not a real one. */
  invented: boolean;
  /** Turning points planned with the walk: where the story could go another way. */
  forks?: ScenarioFork[];
}

/**
 * Another way the story could go from a step (`at`, a stop of the walk):
 * through other stops, in the same shoes or in those of someone met there.
 */
export interface ScenarioFork {
  at: number;
  /** An action, e.g. "Monter dans le canot 6 avec Molly Brown". */
  label: string;
  /** Index in `people` when the fork follows someone else from there. */
  person: number | null;
  stops: number[];
}

export interface Story {
  stops: StoryStop[];
  people: StoryPerson[];
  source: Source;
  provider: string;
}

/** How the visitor looks at the world and how they got here: scenarios are written for it. */
export interface ScenarioContext {
  /** Lens id when the filters are exactly a lens (`LENSES`). */
  lens: string | null;
  /** Themes shown. */
  themes: Theme[];
  /** People shown on the map. */
  people: boolean;
  /** Titles of the cards read before this one, oldest first (the walk so far). */
  trail: string[];
}

/** `no-ai`: no AI can read the article now; `none`: nothing was found. */
export type StoryStatus = 'ready' | 'pending' | 'none' | 'no-ai';

export interface StoryResponse {
  status: StoryStatus;
  story: Story | null;
  /** Its places as the article heads them, an AI labelling them meanwhile: ask again. */
  draft?: boolean;
}

export interface ScenariosResponse {
  status: StoryStatus;
  scenarios: StoryScenario[];
  /** The reading they walk through (its stops and people are what they number), when ready. */
  story?: Story;
  /** The first ones, more being written: ask again. */
  more?: boolean;
}

/** A moment of a walk, self-contained: the place, the year, what the character lives there and who is around. */
export interface WalkStep {
  /** As the story names it, e.g. "Southampton". */
  place: string;
  /** Its part in the story, e.g. "Port de départ". */
  label: string;
  year: number;
  /** The day, as a decimal year, when the story gives it. */
  when?: number | null;
  lat: number;
  lon: number;
  /** The place's card, when it has one. */
  poi: PoiLite | null;
  /** What is at stake for the character there, in a line (planned with the walk). */
  beat?: string;
  /** What the character lives there; empty until written, when the visitor gets there. */
  text: string;
  cast: StoryPerson[];
  /** The stop of the card's story it walks through (`ScenarioWalk.from`): its text is written from it. */
  stop?: number;
  /** The place's picture. */
  image?: string | null;
  /** Short detours from here (a place of the story, someone met, a card close by), offered once its text is written. */
  choices?: StepChoice[];
  /** The way on along the planned route, as an action ("Appareiller pour Cherbourg"), once written. */
  next?: string | null;
  /** Other ways the story may go from here, planned with the walk. */
  forks?: WalkFork[];
  /** The choice taken here, if any. */
  chosen?: number;
  /** "Autour de vous": a few dated, numbered facts of the article. */
  facts?: string[];
  /** A sentence of the article, word for word. */
  quote?: StepQuote | null;
  /** More pictures of the place and the moment. */
  gallery?: string[];
  /** Other cards close by, at the same moment: short detours. */
  near?: PoiLite[];
}

/** A turning point of a walk: its own steps, in the same shoes or someone else's. */
export interface WalkFork {
  label: string;
  /** Whom it follows from there, when someone else. */
  hero: StoryPerson | null;
  steps: WalkStep[];
}

export interface StepQuote {
  text: string;
  /** The article it comes from. */
  source: Source;
}

/** A turn the story may take from a step: another place of the same story, next; another card, or someone met there, as a detour. */
export interface StepChoice {
  /** "Suivre les rescapés jusqu'à New York". */
  label: string;
  step?: WalkStep;
  poi?: PoiLite;
  /** Someone present: a few moments of their life around this one, in their shoes. */
  person?: StoryPerson;
}

/** A step's text, written when the visitor gets there (`pending` meanwhile). */
export interface StepResponse {
  status: StoryStatus;
  text: string | null;
  /** The people present, as the writer placed them. */
  cast: StoryPerson[];
  choices: StepChoice[];
  /** The way on along the planned route, as an action. */
  next: string | null;
  facts: string[];
  quote: StepQuote | null;
  gallery: string[];
  near: PoiLite[];
}

/** A link of a card's introduction, made something to act on: a person, a card, a place. */
export interface CardLink {
  /** The words linked in the text, e.g. "Edward Smith". */
  label: string;
  /** Its Wikipedia article. */
  url: string;
  kind: 'person' | 'card' | 'place';
  person?: StoryPerson & { description?: string | null };
  poi?: PoiLite;
  lat?: number;
  lon?: number;
}

export interface CardLinksResponse {
  links: CardLink[];
}

/**
 * A scenario ready to be played on its own, whatever card is open: the
 * player keeps it going (or paused) while the visitor explores elsewhere.
 * Written over a card's story, or across the cards of a real person's life.
 */
export interface ScenarioWalk {
  /** Stable across readings: the card's id (or the person's item) and the title. */
  id: string;
  title: string;
  premise: string;
  invented: boolean;
  /** The real person followed, if any. */
  hero: StoryPerson | null;
  steps: WalkStep[];
  /** The article it was written from. */
  source: Source;
  /** The card it was written on; null for a person's life, which crosses cards. */
  from: PoiLite | null;
  /** What the story led to, beyond the walk: cards to go on from at its end. */
  after?: WalkLead[];
  /** A fork's walk: the stops lived before it (on the walk it leaves), for the writer. */
  prelude?: number[];
  /** A fork's walk: the turns taken before it, oldest first, for the writer. */
  decisions?: string[];
}

/** A card the story leads to after the walk (an inquiry, a law, a war). */
export interface WalkLead {
  label: string;
  year: number;
  poi: PoiLite;
}

/** Leads at most offered at the end of a walk. */
const MAX_AFTER = 3;

/** "10 avr. 1912" when the day is known, else "1912". */
export function formatWhen(s: { year: number; when?: number | null }): string {
  return s.when != null ? formatDay(s.when) : formatYear(s.year);
}

/** A stop of a card's story as a step of a walk. */
function stepAt(story: Story, stop: number, extra: { text?: string; cast?: number[]; beat?: string } = {}): WalkStep | null {
  const s = story.stops[stop];
  if (!s) return null;
  return {
    place: s.poi?.title ?? s.name, label: s.label, year: s.year, when: s.when ?? null, lat: s.lat, lon: s.lon, poi: s.poi,
    text: extra.text ?? '', cast: (extra.cast ?? []).flatMap((c) => (story.people[c] ? [story.people[c]!] : [])), stop, image: s.image ?? null,
    ...(extra.beat ? { beat: extra.beat } : {}),
  };
}

/** A card's scenario as a walk: its stops and people written out, its turning points hung on their steps. Pure, for tests. */
export function walkOf(from: PoiLite, story: Story, sc: StoryScenario): ScenarioWalk {
  const hero = sc.person !== null ? story.people[sc.person] ?? null : null;
  // Cards the walk already goes through are no leads (a port may be two stops of the story).
  const seen = new Set<string>([from.id, ...sc.steps.flatMap((st) => story.stops[st.stop]?.poi?.id ?? [])]);
  const after = story.stops.flatMap((s) => {
    if (s.phase !== 'after' || s.main === false || !s.poi || seen.has(s.poi.id)) return [];
    seen.add(s.poi.id);
    return [{ label: s.label, year: s.year, poi: s.poi }];
  }).slice(0, MAX_AFTER);
  const steps = sc.steps.flatMap((st) => {
    const step = stepAt(story, st.stop, st);
    if (!step) return [];
    const forks = (sc.forks ?? []).flatMap((f): WalkFork[] => {
      if (f.at !== st.stop) return [];
      const fs = f.stops.flatMap((i) => stepAt(story, i) ?? []);
      return fs.length ? [{ label: f.label, hero: f.person !== null ? story.people[f.person] ?? null : null, steps: fs }] : [];
    });
    return [forks.length ? { ...step, forks } : step];
  });
  return {
    after,
    id: `${from.id}|${sc.title}`,
    title: sc.title,
    premise: sc.premise,
    invented: sc.invented,
    hero,
    from,
    source: story.source,
    steps,
  };
}

/**
 * A turning point taken: a walk of its own, hung on the step it leaves,
 * remembering what was lived before it (for the writer). Pure, for tests.
 */
export function forkWalk(walk: ScenarioWalk, at: number, k: number): ScenarioWalk | null {
  const st = walk.steps[at];
  const f = st?.forks?.[k];
  if (!st || !f) return null;
  const before = walk.steps.slice(0, at + 1);
  const chosen = before.flatMap((s) => (s.chosen !== undefined && s.choices?.[s.chosen] ? [s.choices[s.chosen]!.label] : []));
  const hero = f.hero ?? (walk.invented ? null : walk.hero);
  const role = f.hero?.role ? `, ${f.hero.role.charAt(0).toLowerCase()}${f.hero.role.slice(1)}` : '';
  return {
    id: `${walk.id}|bifurcation|${at}|${k}`,
    title: f.label,
    premise: f.hero ? `Vous suivez désormais ${f.hero.name}${role}.` : walk.premise,
    invented: f.hero ? false : walk.invented,
    hero,
    from: walk.from,
    source: walk.source,
    after: walk.after,
    prelude: [...(walk.prelude ?? []), ...before.flatMap((s) => (s.stop === undefined ? [] : [s.stop]))],
    decisions: [...(walk.decisions ?? []), ...chosen, f.label].slice(-6),
    steps: f.steps.map((s) => ({ ...s, cast: f.hero && !s.cast.some((c) => c.qid === f.hero!.qid) ? [f.hero, ...s.cast] : s.cast })),
  };
}

/** A short detour (2-3 steps) branching off a walk: around a person, or at a place's card, near a year. */
export type DetourKind = 'person' | 'card';

/** A real person's life as a scenario, across the cards where they appear, or a detour (`pending` while an AI writes it). */
export interface PersonScenarioResponse {
  status: StoryStatus;
  walk: ScenarioWalk | null;
}
