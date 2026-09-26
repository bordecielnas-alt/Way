import { z } from 'zod';

export const Category = z.enum([
  'battle', 'city', 'polity', 'monument', 'religion', 'person', 'event', 'discovery',
  'disaster', 'trade', 'art', 'science', 'nature', 'place',
]);
export type Category = z.infer<typeof Category>;

export const CATEGORY_LABELS: Record<Category, string> = {
  battle: 'Guerre et bataille',
  city: 'Ville',
  polity: 'État et empire',
  monument: 'Monument',
  religion: 'Religion',
  person: 'Personnage',
  event: 'Événement',
  discovery: 'Archéologie et découverte',
  disaster: 'Catastrophe',
  trade: 'Commerce et routes',
  art: 'Art',
  science: 'Science et techniques',
  nature: 'Site naturel',
  place: 'Lieu',
};

export const DatePrecision = z.enum(['exact_year', 'decade', 'century', 'millennium', 'approximate']);
export const GeoPrecision = z.enum(['exact', 'city', 'region', 'approximate']);
export const Confidence = z.enum(['verified', 'web_single_source', 'disputed']);
export const Provenance = z.enum(['wikidata', 'wikipedia', 'web_ai']);

export const Source = z.object({
  url: z.url(),
  title: z.string(),
  kind: z.enum(['wikidata', 'wikipedia', 'web']),
});
export type Source = z.infer<typeof Source>;

/** Full POI (brief §6.1). `summary` is filled lazily when the card is first opened. */
export const Poi = z.object({
  id: z.string(),
  title: z.string().min(1),
  summary: z.string().nullable(),
  summary_lang: z.string().nullable(),
  description: z.string().nullable(),
  category: Category,
  tags: z.array(z.string()),
  date_start: z.number().int(),
  date_end: z.number().int().nullable(),
  date_precision: DatePrecision,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  geo_precision: GeoPrecision,
  h3_cells: z.array(z.string()),
  importance: z.number().min(0).max(1),
  confidence: Confidence,
  provenance: Provenance,
  sources: z.array(Source).min(1),
  image_url: z.string().nullable(),
  wikidata_qid: z.string().nullable(),
  wiki_title: z.string().nullable(),
  wiki_lang: z.string().nullable(),
  view_count: z.number().int(),
});
export type Poi = z.infer<typeof Poi>;

/** Fields needed to draw a marker. */
export type PoiLite = Pick<
  Poi,
  'id' | 'title' | 'category' | 'date_start' | 'date_end' | 'date_precision' | 'lat' | 'lon' | 'importance' | 'confidence'
>;

export function toLite(p: Poi): PoiLite {
  const { id, title, category, date_start, date_end, date_precision, lat, lon, importance, confidence } = p;
  return { id, title, category, date_start, date_end, date_precision, lat, lon, importance, confidence };
}

/** Does the POI's date span intersect the inclusive window [t0, t1]? */
export function poiInWindow(p: Pick<Poi, 'date_start' | 'date_end'>, t0: number, t1: number): boolean {
  return p.date_start <= t1 && (p.date_end ?? p.date_start) >= t0;
}
