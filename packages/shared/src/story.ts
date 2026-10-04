import type { PoiLite, Source } from './poi.ts';
import type { Theme } from './themes.ts';

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
   * people present (indexes in `people`), placed on the map at that step.
   */
  steps: { stop: number; text: string; cast: number[] }[];
  /** Index in `people` when the scenario follows one of them. */
  person: number | null;
  /** An invented character (a typical person of the time), not a real one. */
  invented: boolean;
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
  lat: number;
  lon: number;
  /** The place's card, when it has one. */
  poi: PoiLite | null;
  /** What the character lives there; empty until written, when the visitor gets there. */
  text: string;
  cast: StoryPerson[];
  /** The stop of the card's story it walks through (`ScenarioWalk.from`): its text is written from it. */
  stop?: number;
  /** The place's picture. */
  image?: string | null;
  /** Where the story may lead from here, offered once its text is written. */
  choices?: StepChoice[];
  /** The choice taken here, if any. */
  chosen?: number;
}

/** A turn the story may take from a step: another place of the same story, next. */
export interface StepChoice {
  /** "Suivre les rescapés jusqu'à New York". */
  label: string;
  step: WalkStep;
}

/** A step's text, written when the visitor gets there (`pending` meanwhile). */
export interface StepResponse {
  status: StoryStatus;
  text: string | null;
  /** The people present, as the writer placed them. */
  cast: StoryPerson[];
  choices: StepChoice[];
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
}

/** A card the story leads to after the walk (an inquiry, a law, a war). */
export interface WalkLead {
  label: string;
  year: number;
  poi: PoiLite;
}

/** Leads at most offered at the end of a walk. */
const MAX_AFTER = 3;

/** A card's scenario as a walk: its stops and people written out. Pure, for tests. */
export function walkOf(from: PoiLite, story: Story, sc: StoryScenario): ScenarioWalk {
  const hero = sc.person !== null ? story.people[sc.person] ?? null : null;
  // Cards the walk already goes through are no leads (a port may be two stops of the story).
  const seen = new Set<string>([from.id, ...sc.steps.flatMap((st) => story.stops[st.stop]?.poi?.id ?? [])]);
  const after = story.stops.flatMap((s) => {
    if (s.phase !== 'after' || s.main === false || !s.poi || seen.has(s.poi.id)) return [];
    seen.add(s.poi.id);
    return [{ label: s.label, year: s.year, poi: s.poi }];
  }).slice(0, MAX_AFTER);
  return {
    after,
    id: `${from.id}|${sc.title}`,
    title: sc.title,
    premise: sc.premise,
    invented: sc.invented,
    hero,
    from,
    source: story.source,
    steps: sc.steps.flatMap((st) => {
      const s = story.stops[st.stop];
      if (!s) return [];
      return [{
        place: s.poi?.title ?? s.name, label: s.label, year: s.year, lat: s.lat, lon: s.lon, poi: s.poi, text: st.text,
        cast: st.cast.flatMap((c) => (story.people[c] ? [story.people[c]!] : [])), stop: st.stop, image: s.image ?? null,
      }];
    }),
  };
}

/** A short detour (2-3 steps) branching off a walk: around a person, or at a place's card, near a year. */
export type DetourKind = 'person' | 'card';

/** A real person's life as a scenario, across the cards where they appear, or a detour (`pending` while an AI writes it). */
export interface PersonScenarioResponse {
  status: StoryStatus;
  walk: ScenarioWalk | null;
}
