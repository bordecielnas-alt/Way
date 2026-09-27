// Card of a kingdom or empire clicked on the map.

export interface PolityRulerInfo {
  qid: string;
  name: string;
  office: string | null;
  start: number | null;
  end: number | null;
  image: string | null;
  /** Reigning at the asked year, or the closest reign before / after it. */
  when: 'now' | 'before' | 'after';
}

export interface PolityInfo {
  /** Name in the border snapshot. */
  name: string;
  year: number;
  /** Wikidata item matched to the name; null when nothing fits. */
  qid: string | null;
  title: string;
  kind: string | null;
  description: string | null;
  start: number | null;
  end: number | null;
  /** Flag, else coat of arms. */
  emblem: string | null;
  image: string | null;
  capital: string | null;
  government: string[];
  religion: string[];
  languages: string[];
  rulers: PolityRulerInfo[];
  summary: string | null;
  summaryLang: string | null;
  sources: { title: string; url: string }[];
}

export interface PolityLabels {
  /** English snapshot name -> French name, for confident matches only. */
  labels: Record<string, string>;
  /** Names still being looked up. */
  pending: number;
}
