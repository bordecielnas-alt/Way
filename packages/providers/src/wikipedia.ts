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

interface ExtractResponse { query?: { pages?: { title: string; extract?: string; missing?: boolean }[] } }

/** An article's plain text (all sections), clipped to `chars`. Null for a missing page. */
export async function pageText(lang: string, title: string, chars = 12_000): Promise<{ title: string; url: string; text: string } | null> {
  const params = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'plain',
    titles: title, format: 'json', formatversion: '2', redirects: '1',
  });
  const r = await fetchJson<ExtractResponse>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  const p = r.query?.pages?.[0];
  if (!p || p.missing || !p.extract) return null;
  return { title: p.title, url: articleUrl(lang, p.title), text: p.extract.length > chars ? `${p.extract.slice(0, chars)}…` : p.extract };
}

interface LinksResponse {
  continue?: Record<string, string>;
  query?: {
    pages?: { title: string; missing?: boolean; pageprops?: { wikibase_item?: string } }[];
    redirects?: { from: string; to: string }[];
  };
}

/**
 * The Wikidata items an article links to, with the titles that led there
 * (the page's own, and the redirects the article used). The article's own
 * links say which Southampton or which Edward Smith it means.
 */
export async function linkedItems(lang: string, title: string, max = 2000): Promise<{ qid: string; titles: string[] }[]> {
  const byTitle = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  let cont: Record<string, string> = {};
  for (let page = 0; page < 6 && byTitle.size < max; page++) {
    const params = new URLSearchParams({
      action: 'query', generator: 'links', titles: title, gplnamespace: '0', gpllimit: 'max',
      prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', format: 'json', formatversion: '2', ...cont,
    });
    const r = await fetchJson<LinksResponse>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
    for (const p of r.query?.pages ?? []) if (p.pageprops?.wikibase_item) byTitle.set(p.title, p.pageprops.wikibase_item);
    for (const rd of r.query?.redirects ?? []) aliases.set(rd.to, [...(aliases.get(rd.to) ?? []), rd.from]);
    if (!r.continue) break;
    cont = r.continue;
  }
  return [...byTitle].map(([t, qid]) => ({ qid, titles: [t, ...(aliases.get(t) ?? [])] }));
}
