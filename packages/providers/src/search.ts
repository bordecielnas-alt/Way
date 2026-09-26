import { fetchJson } from './http.ts';

// Web search adapters for level 2 (brief §8.2). Each returns hits with the
// best text it can get cheaply: full article text for Wikipedia, snippets
// for web engines.

export interface SearchHit {
  title: string;
  url: string;
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'");

interface WikiSearchResponse { query?: { search?: { title: string }[] } }
interface WikiExtractResponse { query?: { pages?: { title: string; extract?: string; missing?: boolean }[] } }

/** Wikipedia full-text search, keyless: top articles with their plain text (clipped). */
export async function wikipediaSearch(lang: string, query: string, limit = 4, chars = 3500): Promise<SearchHit[]> {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const s = await fetchJson<WikiSearchResponse>(
    `${base}?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json', formatversion: '2' })}`,
  );
  const titles = (s.query?.search ?? []).map((x) => x.title);
  // Full-text extracts are served one page per request.
  const pages = await Promise.all(
    titles.map((t) =>
      fetchJson<WikiExtractResponse>(
        `${base}?${new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'plain', titles: t, format: 'json', formatversion: '2', redirects: '1' })}`,
      ).then((r) => r.query?.pages?.[0]),
    ),
  );
  return pages.flatMap((p) =>
    p && !p.missing && p.extract
      ? [{ title: p.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`, text: clip(p.extract, chars) }]
      : [],
  );
}

interface TavilyResponse { results?: { title: string; url: string; content: string }[] }

/** Tavily (free credits, API key). */
export async function tavilySearch(apiKey: string, query: string, limit = 6): Promise<SearchHit[]> {
  const r = await fetchJson<TavilyResponse>('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
    retries: 0,
  });
  return (r.results ?? []).map((x) => ({ title: x.title, url: x.url, text: clip(x.content, 1500) }));
}

interface BraveResponse { web?: { results?: { title: string; url: string; description?: string; extra_snippets?: string[] }[] } }

/** Brave Search API (API key; the free plan now needs a card: disabled unless configured). */
export async function braveSearch(apiKey: string, query: string, limit = 6): Promise<SearchHit[]> {
  const r = await fetchJson<BraveResponse>(
    `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit), search_lang: 'fr' })}`,
    { headers: { 'X-Subscription-Token': apiKey }, retries: 0 },
  );
  return (r.web?.results ?? []).map((x) => ({
    title: stripTags(x.title),
    url: x.url,
    text: clip(stripTags([x.description ?? '', ...(x.extra_snippets ?? [])].join(' ')), 1500),
  }));
}

interface SearxResponse { results?: { title: string; url: string; content?: string }[] }

/** Self-hosted SearXNG (JSON format must be enabled in its settings). */
export async function searxngSearch(baseUrl: string, query: string, limit = 6): Promise<SearchHit[]> {
  const r = await fetchJson<SearxResponse>(
    `${baseUrl.replace(/\/$/, '')}/search?${new URLSearchParams({ q: query, format: 'json', language: 'fr' })}`,
    { retries: 0 },
  );
  return (r.results ?? []).slice(0, limit).map((x) => ({ title: x.title, url: x.url, text: clip(x.content ?? '', 1500) }));
}
