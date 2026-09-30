import { z } from 'zod';
import { histToAstro, MAX_YEAR, MIN_YEAR, type Poi, type Source } from '@way/shared';
import { wikidata, wikipedia, type DatedRow } from '@way/providers';
import type { ProviderRouter } from './router.ts';

// Causes and consequences read in a card's Wikipedia article (level 2), for
// the doors Wikidata leaves empty. The AI only names them; each link must
// quote the article, and each destination must be a dated, located Wikidata
// item whose date fits the one the article gives.

export interface AiLink { row: DatedRow; why: string }
export interface AiLinks { source: Source; cause: AiLink[]; effect: AiLink[] }

const MAX_LINKS = 4;
/** Years a destination's Wikidata date may differ from the article's. */
const YEAR_SLACK = 10;
const ARTICLE_CHARS = 12_000;

const Item = z.object({
  name: z.string().trim().min(2).max(160),
  year: z.number().int(),
  why: z.string().trim().min(2).max(90),
  quote: z.string().trim().min(12).max(500),
});
export const Extracted = z.object({
  causes: z.array(Item.nullable().catch(null)).max(12).catch([]),
  effects: z.array(Item.nullable().catch(null)).max(12).catch([]),
});
type Item = z.infer<typeof Item>;

const SYSTEM = `You read a Wikipedia article about a historical subject and list what the ARTICLE ITSELF presents as its causes and as its consequences.
Rules, all mandatory:
- Use ONLY links the article states explicitly. Never add knowledge of your own. An empty list is better than a doubtful one.
- Keep only precise, dated historical events, battles, treaties, foundations, reigns or constructions that could have their own Wikipedia article. No vague trends ("economic crisis", "tensions").
- name: the usual title of that event's Wikipedia article, in the article's language (e.g. "Bataille de Stamford Bridge").
- year: its year, historical: negative before Christ (-44 = 44 BC), no year 0.
- why: a short French label of the link, 2 to 8 words (e.g. "Revendication du trône", "Fin de la dynastie").
- quote: the exact words of the article (copied verbatim, 12 to 300 characters) that state the link.
- At most ${MAX_LINKS} causes and ${MAX_LINKS} effects, the most important first.
Answer with a single JSON object: {"causes": [...], "effects": [...]}.`;

/** Lowercase, accents and punctuation removed, spaces collapsed: for quote checks. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Does the article contain the quote (its first words at least, the AI may cut it)? */
export function quoted(article: string, quote: string): boolean {
  const q = normalize(quote);
  if (q.length < 10) return false;
  return normalize(article).includes(q.slice(0, 80));
}

/**
 * Picks, for each item, the first matching Wikidata item whose date fits
 * the article's year and the direction of the link. Pure, for tests.
 */
export function matchItems(
  poi: Pick<Poi, 'date_start' | 'date_end' | 'wikidata_qid'>,
  kind: 'cause' | 'effect',
  items: { item: Item; qids: string[] }[],
  rows: Map<string, DatedRow>,
): AiLink[] {
  const start = histToAstro(poi.date_start);
  const end = histToAstro(poi.date_end ?? poi.date_start);
  const out: AiLink[] = [];
  const seen = new Set<string>();
  for (const { item, qids } of items) {
    const row = qids
      .filter((q) => q !== poi.wikidata_qid && !seen.has(q))
      .map((q) => rows.get(q))
      .find((r): r is DatedRow => {
        if (!r || Math.abs(histToAstro(r.year) - histToAstro(item.year)) > YEAR_SLACK) return false;
        const y = histToAstro(r.year);
        return kind === 'cause' ? y <= end : y >= start;
      });
    if (!row) continue;
    seen.add(row.qid);
    out.push({ row, why: item.why.charAt(0).toUpperCase() + item.why.slice(1) });
  }
  return out;
}

/** Causes and consequences of a POI read in its article, or null (no article, no AI, nothing found). */
export async function aiLinks(poi: Poi, router: ProviderRouter): Promise<AiLinks | null> {
  if (!poi.wiki_title || !poi.wiki_lang) return null;
  const lang = poi.wiki_lang;
  const article = await wikipedia.pageText(lang, poi.wiki_title, ARTICLE_CHARS).catch(() => null);
  if (!article) return null;
  const answer = await router.completeJson('extract', SYSTEM, `Article « ${article.title} » :\n\n${article.text}`, (v) => Extracted.parse(v));
  if (!answer) return null;
  const keep = (list: (Item | null)[]) =>
    list.filter((x): x is Item => !!x && quoted(article.text, x.quote)).slice(0, MAX_LINKS);
  const causes = keep(answer.value.causes);
  const effects = keep(answer.value.effects);
  if (causes.length + effects.length === 0) return null;

  const named = await Promise.all(
    [...causes, ...effects].map(async (item) => ({
      item,
      qids: await wikidata.searchItems(item.name, lang, 3).catch(() => [] as string[]),
    })),
  );
  const all = [...new Set(named.flatMap((n) => n.qids))];
  const rows = new Map((await wikidata.queryDatedByQids(all, MIN_YEAR, MAX_YEAR + 1)).map((r) => [r.qid, r]));
  const source: Source = { url: article.url, title: `Wikipédia : ${article.title}`, kind: 'wikipedia' };
  return {
    source,
    cause: matchItems(poi, 'cause', named.slice(0, causes.length), rows),
    effect: matchItems(poi, 'effect', named.slice(causes.length), rows),
  };
}
