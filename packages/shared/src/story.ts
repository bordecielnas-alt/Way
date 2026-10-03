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
}

export interface ScenariosResponse {
  status: StoryStatus;
  scenarios: StoryScenario[];
}
