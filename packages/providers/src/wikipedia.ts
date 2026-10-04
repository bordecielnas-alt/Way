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

interface ParseResponse { parse?: { title: string; wikitext?: string } }

/** An article's wikitext (its sections and links as written), following redirects. Null for a missing page. */
export async function pageWikitext(lang: string, title: string): Promise<{ title: string; url: string; wikitext: string } | null> {
  const params = new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext', redirects: '1', format: 'json', formatversion: '2' });
  try {
    const r = await fetchJson<ParseResponse>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
    if (!r.parse?.wikitext) return null;
    return { title: r.parse.title, url: articleUrl(lang, r.parse.title), wikitext: r.parse.wikitext };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** A linked article: its Wikidata item, and where it is when it has coordinates ({{coord}} type and size). */
export interface PageInfo {
  title: string;
  qid: string | null;
  lat: number | null;
  lon: number | null;
  /** "city", "landmark", "event", "country", "waterbody"… as the article's {{coord}} says. */
  type: string | null;
  /** Its size in meters, when given. */
  dim: number | null;
  /** Its article's picture, a thumbnail. */
  image: string | null;
}

interface InfoResponse {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: {
      title: string; missing?: boolean; pageprops?: { wikibase_item?: string };
      coordinates?: { lat: number; lon: number; globe?: string; type?: string; dim?: string | number; primary?: string | boolean }[];
      thumbnail?: { source: string };
    }[];
  };
}

/** Linked titles, by the title as asked (redirects and casing followed): 50 at a time, a few in parallel. */
export async function pagesInfo(lang: string, titles: string[]): Promise<Map<string, PageInfo>> {
  const out = new Map<string, PageInfo>();
  const chunks: string[][] = [];
  for (let i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));
  const one = async (chunk: string[]) => {
    const params = new URLSearchParams({
      action: 'query', titles: chunk.join('|'), prop: 'coordinates|pageprops|pageimages', ppprop: 'wikibase_item',
      coprop: 'type|dim|globe', colimit: 'max', piprop: 'thumbnail', pithumbsize: '480', pilimit: '50', redirects: '1', format: 'json', formatversion: '2',
    });
    const r = await fetchJson<InfoResponse>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
    const byTitle = new Map<string, PageInfo>();
    for (const p of r.query?.pages ?? []) {
      if (p.missing) continue;
      const c = p.coordinates?.find((x) => !x.globe || x.globe === 'earth');
      const dim = c?.dim === undefined ? null : Number(String(c.dim).replace(/km$/, '000').replace(/[^0-9.]/g, '')) || null;
      byTitle.set(p.title, { title: p.title, qid: p.pageprops?.wikibase_item ?? null, lat: c?.lat ?? null, lon: c?.lon ?? null, type: c?.type ?? null, dim, image: p.thumbnail?.source ?? null });
    }
    const norm = new Map((r.query?.normalized ?? []).map((n) => [n.from, n.to]));
    const redir = new Map((r.query?.redirects ?? []).map((n) => [n.from, n.to]));
    for (const asked of chunk) {
      const n = norm.get(asked) ?? asked;
      const info = byTitle.get(redir.get(n) ?? n);
      if (info) out.set(asked, info);
    }
  };
  for (let i = 0; i < chunks.length; i += 4) await Promise.all(chunks.slice(i, i + 4).map(one));
  return out;
}

interface ImagesResponse {
  query?: { pages?: { title: string; imageinfo?: { thumburl?: string; mime?: string; width?: number; height?: number }[] }[] };
}

/** Files that illustrate nothing of a story: flags, logos, icons, signatures, locator maps. */
const NOT_A_PICTURE = /(flag|drapeau|logo|icon|ic[oô]ne|symbol|blason|coat[_ ]of[_ ]arms|armoiries|signature|locator|location[_ ]map|localisation|wikidata|commons|edit|question|disambig|portail|portal|pictogram|button|stub)/i;

/**
 * The pictures an article shows (photographs, paintings, engravings), as
 * thumbnails about `width` wide: no flags, logos, icons or locator maps.
 */
export async function pageImages(lang: string, title: string, limit = 6, width = 640): Promise<string[]> {
  const params = new URLSearchParams({
    action: 'query', generator: 'images', titles: title, gimlimit: '50', prop: 'imageinfo',
    iiprop: 'url|mime|size', iiurlwidth: String(width), redirects: '1', format: 'json', formatversion: '2',
  });
  const r = await fetchJson<ImagesResponse>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  return (r.query?.pages ?? []).flatMap((p) => {
    const i = p.imageinfo?.[0];
    if (!i?.thumburl || !/^image\/(jpeg|png|webp)$/.test(i.mime ?? '') || NOT_A_PICTURE.test(p.title)) return [];
    if ((i.width ?? 0) < 280 || (i.height ?? 0) < 180) return [];
    return [i.thumburl];
  }).slice(0, limit);
}

/** Files named by an article ("Titanic leaving Southampton.jpg"), as thumbnails about `width` wide, in the order given: pictures only. */
export async function fileThumbs(lang: string, files: string[], width = 640): Promise<string[]> {
  if (!files.length) return [];
  const asked = files.slice(0, 50).map((f) => `File:${f}`);
  const params = new URLSearchParams({
    action: 'query', titles: asked.join('|'), prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: String(width), format: 'json', formatversion: '2',
  });
  const r = await fetchJson<ImagesResponse & { query?: { normalized?: { from: string; to: string }[] } }>(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  const norm = new Map((r.query?.normalized ?? []).map((n) => [n.from, n.to]));
  const byTitle = new Map((r.query?.pages ?? []).map((p) => [p.title, p]));
  return asked.flatMap((a) => {
    const p = byTitle.get(norm.get(a) ?? a);
    const i = p?.imageinfo?.[0];
    if (!p || !i?.thumburl || !/^image\/(jpeg|png|webp)$/.test(i.mime ?? '') || NOT_A_PICTURE.test(p.title)) return [];
    if ((i.width ?? 0) < 280 || (i.height ?? 0) < 180) return [];
    return [i.thumburl];
  });
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
