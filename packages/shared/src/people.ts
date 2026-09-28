// People followed on the map, and armies on campaign.

/** What someone is doing at a moment of their life. */
export type ActivityKind =
  | 'birth' | 'death' | 'study' | 'stay' | 'work' | 'reign' | 'office'
  | 'battle' | 'coronation' | 'marriage' | 'event' | 'travel' | 'sail' | 'wait';

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  birth: 'Naissance', death: 'Mort', study: 'Études', stay: 'Séjour', work: 'Travail', reign: 'Règne',
  office: 'Fonction', battle: 'Combat', coronation: 'Couronnement', marriage: 'Mariage', event: 'Événement',
  travel: 'En route', sail: 'En bateau', wait: 'Attente',
};

/** A dated moment of a life, placed when Wikidata knows where. Years are decimal (1805.9 ≈ December 1805). */
export interface JourneyStop {
  kind: ActivityKind;
  /** What: the school, the battle, the office… */
  label: string;
  qid: string | null;
  lat: number | null;
  lon: number | null;
  start: number;
  end: number | null;
}

export interface PersonJourney {
  qid: string;
  name: string;
  description: string | null;
  image: string | null;
  born: number | null;
  died: number | null;
  stops: JourneyStop[];
}

export interface PersonHit {
  qid: string;
  name: string;
  description: string | null;
  born: number | null;
  died: number | null;
  image: string | null;
}

export interface ArmyBattle {
  qid: string;
  label: string;
  t: number;
  lat: number;
  lon: number;
  /** Commanders on this side at this battle. */
  commanders: string[];
}

/** One side of a war, from battle to battle. */
export interface Army {
  id: string;
  war: string;
  warQid: string;
  side: string;
  sideQid: string | null;
  battles: ArmyBattle[];
}

export interface ArmiesResponse {
  /** First year of the decade. */
  decade: number;
  armies: Army[];
}
