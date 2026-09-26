import { fetchJson } from './http.ts';

// Geocoding for level 2 (brief §7.2): the LLM gives a place name, never
// coordinates. Wikidata first, then Nominatim (1 request/second, enforced
// by the per-host limiter in http.ts).

export interface Place {
  name: string;
  lat: number;
  lon: number;
  source: 'wikidata' | 'nominatim';
  /** Nominatim's place kind (city, village, building...), when known. */
  kind: string | null;
  url: string;
}

interface WbSearch { search?: { id: string; label?: string }[] }
interface WbEntities {
  entities?: Record<string, { claims?: { P625?: { mainsnak?: { datavalue?: { value?: { latitude: number; longitude: number } } } }[] } }>;
}

/** Wikidata items matching `name` that have coordinates, best match first. */
export async function wikidataPlaces(name: string, lang = 'fr', limit = 5): Promise<Place[]> {
  const s = await fetchJson<WbSearch>(
    `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbsearchentities', search: name, language: lang, uselang: lang, type: 'item', limit: String(limit), format: 'json' })}`,
  );
  const ids = (s.search ?? []).map((x) => x.id);
  if (ids.length === 0) return [];
  const e = await fetchJson<WbEntities>(
    `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', ids: ids.join('|'), props: 'claims', format: 'json' })}`,
  );
  return (s.search ?? []).flatMap((x) => {
    const v = e.entities?.[x.id]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    return v ? [{ name: x.label ?? name, lat: v.latitude, lon: v.longitude, source: 'wikidata' as const, kind: null, url: `https://www.wikidata.org/wiki/${x.id}` }] : [];
  });
}

interface NominatimHit { lat: string; lon: string; display_name: string; addresstype?: string; type?: string; osm_type?: string; osm_id?: number }

const NOMINATIM = 'https://nominatim.openstreetmap.org';

/** Nominatim search, biased to (not limited by) a lon/lat box when given. */
export async function nominatimSearch(
  name: string,
  box?: { west: number; south: number; east: number; north: number },
  limit = 5,
): Promise<Place[]> {
  const params = new URLSearchParams({ q: name, format: 'jsonv2', limit: String(limit), 'accept-language': 'fr' });
  if (box) params.set('viewbox', `${box.west},${box.north},${box.east},${box.south}`);
  const hits = await fetchJson<NominatimHit[]>(`${NOMINATIM}/search?${params}`, { retries: 1 });
  return hits.map((h) => ({
    name: h.display_name,
    lat: Number(h.lat),
    lon: Number(h.lon),
    source: 'nominatim' as const,
    kind: h.addresstype ?? h.type ?? null,
    url: h.osm_type && h.osm_id ? `https://www.openstreetmap.org/${h.osm_type}/${h.osm_id}` : NOMINATIM,
  }));
}

interface NominatimReverse { address?: Record<string, string>; display_name?: string }

/** Short place label for a point ("Arles, France"), at a zoom from 3 (country) to 18 (building). */
export async function nominatimReverse(lat: number, lon: number, zoom: number): Promise<string | null> {
  const r = await fetchJson<NominatimReverse>(
    `${NOMINATIM}/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lon), zoom: String(zoom), format: 'jsonv2', 'accept-language': 'fr' })}`,
    { retries: 1 },
  );
  const a = r.address ?? {};
  const local = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state_district ?? a.state ?? a.region;
  const parts = [local, a.country].filter((x): x is string => !!x);
  return parts.length ? [...new Set(parts)].join(', ') : (r.display_name ?? null);
}
