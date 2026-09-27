import { describe, expect, it } from 'vitest';
import type { PolityCandidate, SubdivisionRow } from '@way/providers';
import { nameSimilarity, regionsAt, rulersAt, scoreCandidate } from './polity.ts';
import { normalizeUi } from './settings.ts';
import { spanYears } from './doors.ts';

const cand = (p: Partial<PolityCandidate>): PolityCandidate => ({
  qid: 'Q1', labelFr: null, labelEn: null, sitelinks: 50, classes: [], starts: [], ends: [], stateProps: 0, ...p,
});

describe('territory matching', () => {
  it('tolerates loose spellings', () => {
    expect(nameSimilarity('Mamluke Sultanate', 'Mamluk Sultanate')).toBe(1);
    expect(nameSimilarity('Castille', 'Kingdom of Castile')).toBe(1);
    expect(nameSimilarity('Mamluke Sultanate', 'Ethiopian Empire')).toBe(0);
  });

  it('prefers the historical kingdom to the modern country long ago', () => {
    const modern = cand({ qid: 'Q142', labelEn: 'France', sitelinks: 330, classes: ['Q6256', 'Q3624078'], starts: [843], stateProps: 5 });
    const kingdom = cand({
      qid: 'Q70972', labelEn: 'Kingdom of France', sitelinks: 110, classes: ['Q3024240'], starts: [987], ends: [1791], stateProps: 4,
    });
    expect(scoreCandidate(kingdom, 'France', 1500)).toBeGreaterThan(scoreCandidate(modern, 'France', 1500));
  });

  it('rejects the city of the same name and states of another era', () => {
    const city = cand({ labelEn: 'Rome', sitelinks: 250, classes: ['Q515', 'Q5119'], starts: [-753] });
    const republic = cand({ labelEn: 'Roman Republic', sitelinks: 120, classes: ['Q3024240'], starts: [-509], ends: [-27], stateProps: 3 });
    const empire = cand({ labelEn: 'Roman Empire', sitelinks: 250, classes: ['Q3024240', 'Q48349'], starts: [-27], ends: [1453], stateProps: 4 });
    const at = (c: PolityCandidate) => scoreCandidate(c, 'Rome', -480);
    expect(at(republic)).toBeGreaterThan(at(city));
    expect(at(republic)).toBeGreaterThan(at(empire));
  });
});

describe('rulers at a date', () => {
  const r = (qid: string, start: number | null, end: number | null) => ({ qid, name: qid, office: null, start, end, image: null });

  it('finds the reigning ruler, with open reigns ending at the next one', () => {
    const list = [r('A', 1461, 1483), r('B', 1483, 1498), r('C', 1498, null), r('D', 1515, 1547)];
    expect(rulersAt(list, 1500).map((x) => [x.qid, x.when])).toEqual([['C', 'now']]);
    expect(rulersAt(list, 1490)[0]?.qid).toBe('B');
  });

  it('shows neighbors only within a generation', () => {
    const list = [r('A', 1200, 1230), r('B', 1260, 1280)];
    expect(rulersAt(list, 1245).map((x) => [x.qid, x.when])).toEqual([['A', 'before'], ['B', 'after']]);
    expect(rulersAt(list, 1500)).toEqual([]);
  });
});

const row = (p: Partial<SubdivisionRow>): SubdivisionRow => ({
  qid: 'Q1', labelFr: null, labelEn: null, sitelinks: 10, classes: ['duchy'], lat: 45, lon: 3,
  starts: [], ends: [], linkStarts: [], linkEnds: [], parents: [], ...p,
});

describe('regions of a territory', () => {
  const rows = [
    row({ qid: 'QD', labelFr: 'duché de Bretagne', starts: [939], ends: [1547], sitelinks: 60 }),
    row({ qid: 'QC', labelEn: 'County of Nantes', classes: ['county'], parents: ['QD'] }),
    row({ qid: 'QP', labelFr: 'Paris', classes: ['city', 'national capital'] }),
    row({ qid: 'QM', labelFr: 'département du Nord', classes: ['department of France'], starts: [1790] }),
    row({ qid: 'QA', labelFr: 'Alsace', classes: ['historical region'], linkStarts: [1648] }),
    row({ qid: 'QX', labelFr: 'sans lieu', lat: null, lon: null }),
  ];

  it('keeps top-level regions valid at the year', () => {
    expect(regionsAt(rows, 'QK', 1500).map((r) => r.qid)).toEqual(['QD']);
    // After 1547 Brittany is gone, its county comes up; Alsace joined in 1648.
    expect(regionsAt(rows, 'QK', 1700).map((r) => r.qid).sort()).toEqual(['QA', 'QC']);
  });

  it('labels regions in French when possible', () => {
    expect(regionsAt(rows, 'QK', 1500)[0]!.label).toBe('duché de Bretagne');
  });
});

describe('settings and meanwhile', () => {
  it('fills interface defaults', () => {
    expect(normalizeUi(undefined)).toEqual({ sounds: true, volume: 0.6, hoverOpen: false, meanwhileMaxSpan: 20 });
    expect(normalizeUi({ volume: 3, meanwhileMaxSpan: -1 } as never)).toMatchObject({ volume: 1, meanwhileMaxSpan: 20 });
  });

  it('measures event spans across year 0', () => {
    expect(spanYears({ date_start: 1337, date_end: 1453 })).toBe(116);
    expect(spanYears({ date_start: -10, date_end: 10 })).toBe(19);
    expect(spanYears({ date_start: 1515, date_end: null })).toBe(0);
  });
});
