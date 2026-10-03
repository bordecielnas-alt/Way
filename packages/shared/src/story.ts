import type { PoiLite, Source } from './poi.ts';

// The story of a subject (brief §4.5, beyond the five doors): an AI reads the
// card's Wikipedia article for the places and moments of its story (where
// the Titanic was built, the ports it left, where it sank, where the dead
// were buried), what it led to (the wars that followed the attacks on the
// World Trade Center), the people who lived it, and a few walks through it
// in someone's shoes. Places and moments quote the article; people are
// Wikidata humans; scenarios are written by the AI over those checked stops.

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
  /** Index in `stops`, and what happens there for that character. */
  steps: { stop: number; text: string }[];
  /** Index in `people` when the scenario follows one of them. */
  person: number | null;
}

export interface Story {
  stops: StoryStop[];
  people: StoryPerson[];
  scenarios: StoryScenario[];
  source: Source;
  provider: string;
}

/** `no-ai`: no AI can read the article now; `none`: nothing was found. */
export type StoryStatus = 'ready' | 'pending' | 'none' | 'no-ai';

export interface StoryResponse {
  status: StoryStatus;
  story: Story | null;
}
