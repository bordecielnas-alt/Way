import { describe, expect, it } from 'vitest';
import type { PolityCandidate, SubdivisionRow } from '@way/providers';
import { cultureAt, faithAt, nameSimilarity, regionsAt, rulersAt, scoreCandidate } from './polity.ts';
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
    expect(normalizeUi(undefined)).toEqual({ sounds: true, volume: 0.6, hoverOpen: false, meanwhileMaxSpan: 1 });
    expect(normalizeUi({ volume: 3, meanwhileMaxSpan: -1 } as never)).toMatchObject({ volume: 1, meanwhileMaxSpan: 1 });
  });

  it('measures event spans across year 0', () => {
    expect(spanYears({ date_start: 1337, date_end: 1453 })).toBe(116);
    expect(spanYears({ date_start: -10, date_end: 10 })).toBe(19);
    expect(spanYears({ date_start: 1515, date_end: null })).toBe(0);
  });
});

describe('faithAt', () => {
  it('picks the faith in force at the year', () => {
    const rome = [
      { faith: 'ancient', start: -27, end: 380, weight: 1 },
      { faith: 'christianity', start: 380, end: null, weight: 1 },
      { faith: 'other', start: null, end: null, weight: 1 },
    ];
    expect(faithAt(rome, 100)).toBe('ancient');
    expect(faithAt(rome, 450)).toBe('christianity');
    // Nothing dated around the year, the undated statement names no known faith: the nearest dated one.
    expect(faithAt(rome, -100)).toBe('ancient');
    // Too far from any of them: the undated one.
    expect(faithAt(rome, -500)).toBe('other');
    const u = (faith: string, weight = 1) => ({ faith, start: null, end: null, weight });
    expect(faithAt([u('islam'), u('other'), u('other')], 900)).toBe('islam');
    // Most weight wins: the official religion over those merely present.
    expect(faithAt([u('christianity'), u('judaism'), u('islam', 2)], 1600)).toBe('islam');
    expect(faithAt([u('islam'), u('christianity'), u('islam')], 1600)).toBe('islam');
    // The Achaemenids: two statements for Zoroastrianism outweigh four local cults.
    expect(faithAt([u('zoroastrianism'), u('zoroastrianism'), u('ancient'), u('ancient'), u('ancient'), u('ancient')], -400)).toBe('zoroastrianism');
    expect(faithAt([u('ancient')], -400)).toBe('ancient');
    expect(faithAt([], 900)).toBeNull();
  });

  it('hears the realm’s kin only when it says nothing itself', () => {
    const kin = (faith: string) => ({ faith, start: null, end: null, weight: 1, kin: true });
    // A duchy with no religion of its own: the one of the realm it was part of.
    expect(faithAt([kin('christianity')], 1200)).toBe('christianity');
    expect(faithAt([{ faith: 'other', start: null, end: null, weight: 1 }, kin('islam')], 1200)).toBe('islam');
    // Its own outweighs any number of its kin's.
    expect(faithAt([{ faith: 'islam', start: null, end: null, weight: 1 }, kin('christianity'), kin('christianity')], 1500)).toBe('islam');
  });
});

describe('cultureAt', () => {
  const c = (faith: string, how: 'people' | 'official' | 'used', weight = how === 'people' ? 3 : how === 'official' ? 2 : 1) =>
    ({ faith, start: null, end: null, weight, how });

  it('reads the people first, then the official languages, then those used', () => {
    // Hungary: Hungarian and (learned) Latin official; Latin weighs little.
    expect(cultureAt([c('uralic', 'official'), c('latin', 'official', 0.4), c('latin', 'used')], 1400)).toBe('uralic');
    // Its people speak before any number of languages used.
    expect(cultureAt([c('turkic', 'people'), c('iranian', 'used'), c('iranian', 'used'), c('semitic', 'used')], 1500)).toBe('turkic');
    expect(cultureAt([c('other', 'official'), c('hellenic', 'used')], 900)).toBe('hellenic');
    expect(cultureAt([], 900)).toBeNull();
    // Poland: only Latin official, Polish used; Latin, a learned language, does not speak for it.
    expect(cultureAt([{ ...c('latin', 'official', 0.4), learned: true }, c('slavic', 'used')], 1305)).toBe('slavic');
    // Hungary: an unknown official language dated 1000–1844 does not hide the Hungarian stated without dates.
    expect(cultureAt([c('uralic', 'used'), { ...c('other', 'official'), start: 1000, end: 1844 }, { ...c('uralic', 'official'), start: 1844, end: null }], 1305)).toBe('uralic');
  });

  it('calls a realm of many peoples by that name rather than by one of them', () => {
    // The Holy Roman Empire: Latin, Polish, Czech, Hungarian, Italian, German official.
    const hre = [c('latin', 'official', 0.4), c('slavic', 'official'), c('slavic', 'official'), c('uralic', 'official'), c('latin', 'official'), c('germanic', 'official')];
    expect(cultureAt(hre, 1500)).toBe('mixed');
    // Two families: the heavier one.
    expect(cultureAt([c('hellenic', 'official'), c('latin', 'official', 0.4)], 900)).toBe('hellenic');
  });
});
