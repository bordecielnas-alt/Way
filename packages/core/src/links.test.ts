import { describe, expect, it } from 'vitest';
import type { DatedRow } from '@way/providers';
import { Extracted, matchItems, quoted } from './links.ts';

const row = (qid: string, year: number): DatedRow => ({ qid, year, lat: 50, lon: 0, precision: 9, prop: 'P585', sitelinks: 10 });
const item = (name: string, year: number, why = 'revendication du trône') => ({ name, year, why, quote: 'une citation assez longue' });

describe('AI links', () => {
  const hastings = { date_start: 1066, date_end: null, wikidata_qid: 'Q83224' };

  it('keeps only quotes found in the article, whatever the accents and punctuation', () => {
    const article = 'Harold II est couronné. Guillaume, duc de Normandie, revendique le trône d’Angleterre…';
    expect(quoted(article, 'Guillaume, duc de Normandie, revendique le trone')).toBe(true);
    expect(quoted(article, 'Guillaume débarque à Pevensey avec 7 000 hommes')).toBe(false);
    expect(quoted(article, 'court')).toBe(false);
  });

  it('matches the first item whose date fits the article and the direction of the link', () => {
    const rows = new Map([row('Q1', 1066), row('Q2', 1086), row('Q3', 1200), row('Q4', 1065)].map((r) => [r.qid, r]));
    // A namesake of another era is skipped for the next item of the search.
    const causes = matchItems(hastings, 'cause', [{ item: item('Stamford Bridge', 1066), qids: ['Q3', 'Q1'] }], rows);
    expect(causes.map((l) => l.row.qid)).toEqual(['Q1']);
    expect(causes[0]!.why).toBe('Revendication du trône');
    // A cause cannot come after the event, a consequence before it; the event itself never.
    expect(matchItems(hastings, 'cause', [{ item: item('Domesday Book', 1086), qids: ['Q2'] }], rows)).toEqual([]);
    expect(matchItems(hastings, 'effect', [{ item: item('Veille', 1065), qids: ['Q4'] }], rows)).toEqual([]);
    expect(matchItems(hastings, 'effect', [{ item: item('Hastings', 1066), qids: ['Q83224'] }], rows)).toEqual([]);
    // One destination once.
    const twice = matchItems(hastings, 'effect', [{ item: item('A', 1086), qids: ['Q2'] }, { item: item('B', 1086), qids: ['Q2'] }], rows);
    expect(twice).toHaveLength(1);
  });

  it('tolerates malformed items in the AI answer', () => {
    const v = Extracted.parse({ causes: [{ name: 'x' }, item('Bataille de Fulford', 1066)], effects: 'none' });
    expect(v.causes.filter(Boolean)).toHaveLength(1);
    expect(v.effects).toEqual([]);
  });
});
