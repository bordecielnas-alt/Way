import type { PoiLite, Source } from './poi.ts';

// Doors (brief §4.5): every card ends with a few chosen destinations.
// Cause and consequence first: they are the threads a walk follows.
export const DOOR_KINDS = ['cause', 'effect', 'meanwhile', 'time', 'surprise'] as const;
export type DoorKind = (typeof DOOR_KINDS)[number];

export interface Door {
  kind: DoorKind;
  /** Door label, e.g. "Ici, 1 500 ans plus tard". */
  title: string;
  /** Why this destination, e.g. "Guerres d'Alexandre le Grand" or "à 4 200 km à l'est". */
  hint: string;
  poi: PoiLite;
  /**
   * The link was read by an AI in this article (Wikidata did not state it):
   * shown with the door, so the reader can check it.
   */
  source?: Source;
}

export interface DoorsResponse {
  doors: Door[];
  /** Kinds still being searched: ask again shortly. */
  pending: DoorKind[];
}

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const DIRECTIONS = ['au nord', 'au nord-est', "à l'est", 'au sud-est', 'au sud', 'au sud-ouest', "à l'ouest", 'au nord-ouest'];

/** "à 4 200 km à l'est" */
export function formatDistance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): string {
  const km = distanceKm(a, b);
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  const dir = DIRECTIONS[Math.round(((bearing + 360) % 360) / 45) % 8]!;
  if (km < 1) return 'tout près';
  const rounded = km < 10 ? Math.round(km) : km < 100 ? Math.round(km / 5) * 5 : Math.round(km / 100) * 100;
  return `à ${rounded.toLocaleString('fr-FR')} km ${dir}`;
}

/** "1 500 ans", "un siècle", "un an" */
export function formatYears(n: number): string {
  const a = Math.abs(n);
  const r = a < 100 ? a : a < 1000 ? Math.round(a / 10) * 10 : Math.round(a / 100) * 100;
  if (r === 1) return 'un an';
  if (r === 100) return 'un siècle';
  if (r === 1000) return 'mille ans';
  return `${r.toLocaleString('fr-FR')} ans`;
}
