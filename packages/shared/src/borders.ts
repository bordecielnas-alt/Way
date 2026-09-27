// Historical borders sent to the globe.

/** One polygon set of a realm or of a member of a composite realm. */
export interface BorderFeature {
  /** Stable within a dataset version. */
  id: number;
  /** English name for that era ("County of Blois"). */
  name: string;
  qid: string | null;
  /** A realm made of members (the kingdom with its duchies and counties). */
  composite: boolean;
  /** The composite realm it belongs to, when drawn inside one. */
  parent: number | null;
  /** km². */
  area: number;
  /**
   * Polygons → rings → coordinates as integer deltas in `quantum` degrees:
   * [dx0, dy0, dx1, dy1…], the first pair from 0.
   */
  g: number[][][];
}

/** Borders are constant from `from` to `to` (inclusive). */
export interface BordersPeriod {
  from: number;
  to: number;
  version: string;
  features: BorderFeature[];
}

export interface BordersIndex {
  version: string;
  quantum: number;
  /** Years where borders change; a period runs from one to the next minus one. */
  events: number[];
}
