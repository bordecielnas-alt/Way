import { fetchJson, HttpError } from './http.ts';

export interface GeoHit {
  title: string;
  lat: number;
  lon: number;
  qid: string | null;
}

interface GeoResponse {
  query?: {
    pages?: { title: string; coordinates?: { lat: number; lon: number }[]; pageprops?: { wikibase_item?: string } }[];
  };
}

/** Wikipedia GeoSearch: articles around a point (radius capped at 10 km by the API). */
export async function geosearch(lang: string, lat: number, lon: number, radiusM: number, limit = 100): Promise<GeoHit[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(Math.min(10_000, Math.max(10, Math.round(radiusM)))),
    ggslimit: String(Math.min(500, limit)),
    prop: 'coordinates|pageprops',
    ppprop: 'wikibase_item',
  });
  const res = await fetchJson<GeoResponse>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  return (res.query?.pages ?? []).flatMap((p) => {
    const c = p.coordinates?.[0];
    return c ? [{ title: p.title, lat: c.lat, lon: c.lon, qid: p.pageprops?.wikibase_item ?? null }] : [];
  });
}

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  image: string | null;
}

interface SummaryResponse {
  title: string;
  extract?: string;
  type?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source: string };
}

/** Lead section summary via the REST API. Returns null for missing pages. */
export async function pageSummary(lang: string, title: string): Promise<WikiSummary | null> {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  try {
    const r = await fetchJson<SummaryResponse>(url);
    if (!r.extract || r.type === 'disambiguation') return null;
    return {
      title: r.title,
      extract: r.extract,
      url: r.content_urls?.desktop?.page ?? articleUrl(lang, title),
      image: r.thumbnail?.source ?? null,
    };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export function articleUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}
