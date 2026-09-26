import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { cellsForPoint, makeKey, type Poi } from '@way/shared';
import { listSnapshots, snapshotFor } from './borders.ts';
import { loadConfig } from './config.ts';
import { planJobs } from './pipeline.ts';
import { MemoryStore } from './store/memory.ts';
import { PostgresStore } from './store/postgres.ts';
import type { Store } from './store/types.ts';

const cfg = loadConfig({});

function poi(over: Partial<Poi> & { wikidata_qid: string }): Poi {
  const lat = over.lat ?? 41.89;
  const lon = over.lon ?? 12.48;
  return {
    id: crypto.randomUUID(),
    title: 'Rome',
    summary: null,
    summary_lang: null,
    description: null,
    category: 'city',
    tags: [],
    date_start: -753,
    date_end: null,
    date_precision: 'exact_year',
    lat,
    lon,
    geo_precision: 'exact',
    h3_cells: cellsForPoint(lat, lon),
    importance: 0.9,
    confidence: 'verified',
    provenance: 'wikidata',
    sources: [{ url: 'https://www.wikidata.org/wiki/Q220', title: 'Wikidata', kind: 'wikidata' }],
    image_url: null,
    wiki_title: 'Rome',
    wiki_lang: 'fr',
    view_count: 0,
    ...over,
  };
}

describe('planJobs', () => {
  it('merges adjacent small global buckets and groups cell buckets', () => {
    const keys = [1914, 1915, 1916, 1930].map((b) => makeKey('g', b)).concat(
      [-800, -750].map((b) => makeKey('g', b)),
      [-800, -750].map((b) => makeKey('841e805ffffffff', b)),
    );
    const jobs = planJobs(keys, cfg);
    expect(jobs).toContainEqual({ kind: 'global', buckets: [1914, 1915, 1916], filter: 'all' });
    expect(jobs).toContainEqual({ kind: 'global', buckets: [1930], filter: 'all' });
    // 50-year buckets exceed the global span limit: one query each.
    expect(jobs).toContainEqual({ kind: 'global', buckets: [-800], filter: 'all' });
    expect(jobs).toContainEqual({ kind: 'area', area: '831e80fffffffff', cells: ['841e805ffffffff'], buckets: [-800, -750], filter: 'all' });
  });
});

async function exerciseStore(store: Store) {
  await store.init();
  const rome = poi({ wikidata_qid: 'Q220' });
  const ostia = poi({ wikidata_qid: 'Q1012797', title: 'Ostie', lat: 41.75, lon: 12.29, importance: 0.5, date_start: -620 });
  const empire = poi({ wikidata_qid: 'Q2277', title: 'Empire romain', category: 'polity', date_start: -27, date_end: 476 });
  await store.upsertPois([rome, ostia, empire]);

  const cell3 = rome.h3_cells[3]!;
  const view = await store.queryView({ res: 3, cells: [cell3], tStart: -800, tEnd: -600, perCell: 10 });
  expect(view.map((p) => p.title).sort()).toEqual(['Ostie', 'Rome']);
  const top1 = await store.queryView({ res: 3, cells: [cell3], tStart: -800, tEnd: -600, perCell: 1 });
  expect(top1.map((p) => p.title)).toEqual(['Rome']);
  const imperial = await store.queryView({ res: 3, cells: [cell3], tStart: 100, tEnd: 120, perCell: 10 });
  expect(imperial.map((p) => p.title)).toEqual(['Empire romain']);

  // Re-upsert keeps the id and lazily-fetched summary.
  await store.updatePoi(rome.id, { summary: 'Résumé' });
  await store.upsertPois([{ ...rome, id: crypto.randomUUID(), title: 'Rome (Italie)' }]);
  const again = await store.getPoi(rome.id);
  expect(again?.title).toBe('Rome (Italie)');
  expect(again?.summary).toBe('Résumé');
  expect(again?.sources[0]?.kind).toBe('wikidata');
  expect(await store.existingQids(['Q220', 'Q999'])).toEqual(new Set(['Q220']));

  await store.touchPoi(rome.id);
  expect((await store.getPoi(rome.id))?.view_count).toBe(1);

  const k = makeKey('g', -800);
  await store.setKeys([k], 'pending');
  await store.setKeys([k], 'done', ['wikidata']);
  expect((await store.getKeys([k, 'nope'])).get(k)?.status).toBe('done');
  expect((await store.keyStats()).done).toBe(1);
  expect(await store.poiCount()).toBe(3);

  await store.setClassCategories(new Map([['Q515', 'city'], ['Q1', null]]));
  const classes = await store.getClassCategories(['Q515', 'Q1', 'Q2']);
  expect(classes.get('Q515')).toBe('city');
  expect(classes.has('Q1')).toBe(true);
  expect(classes.has('Q2')).toBe(false);
}

describe('stores', () => {
  it('memory store', async () => {
    await exerciseStore(new MemoryStore());
  });

  it('postgres store (PGlite)', async () => {
    const db = new PGlite();
    const store = new PostgresStore(db);
    await exerciseStore(store);
    await store.init(); // migrations are idempotent
    await store.close();
  });
});

describe('borders', () => {
  it('picks the latest snapshot at or before a year', () => {
    const snaps = [-2000, -1000, 1, 1914].map((year) => ({ year, file: `${year}` }));
    expect(snapshotFor(snaps, -1500)?.year).toBe(-2000);
    expect(snapshotFor(snaps, 1920)?.year).toBe(1914);
    expect(snapshotFor(snaps, -4000)?.year).toBe(-2000);
    expect(listSnapshots('/nonexistent')).toEqual([]);
  });
});
