import { describe, expect, it } from 'vitest';
import type { ScenarioWalk, WalkStep } from '@way/shared';
import {
  add, clearNext, crochet, emptyQueue, goTo, move, nearSpan, nearWalks, parseQueue, progressOf, remove, runsOf, start, stepOf, takeShelf, treeOf, updateStep,
  type Queue,
} from './queue.ts';

const step = (place: string, year = 1270): WalkStep => ({ place, label: 'Étape', year, lat: 0, lon: 0, poi: null, text: '', cast: [] });
const walk = (id: string, places: string[]): ScenarioWalk => ({
  id, title: id, premise: '…', invented: true, hero: null, from: null, steps: places.map((p) => step(p)),
  source: { url: 'u', title: 't', kind: 'wikipedia' },
});
const places = (q: Queue) => q.items.map((_, i) => stepOf(q, i)!.step.place);
const now = (q: Queue) => stepOf(q, q.at)?.step.place;

const soie = walk('soie', ['Khanbaliq', 'Kachgar', 'Samarcande', 'Tabriz', 'Ayas', 'Venise']);
const bagdad = walk('bagdad', ['Bagdad', 'Maragha']);
const polo = walk('polo', ['Venise', 'Acre', 'Khanbaliq']);

describe('the file', () => {
  it('plays a scenario from a step, its steps next', () => {
    const q = start(emptyQueue(), soie, 3);
    expect(places(q)).toEqual(['Tabriz', 'Ayas', 'Venise']);
    expect(now(q)).toBe('Tabriz');
  });

  it('slips a crochet in after the step now, and goes on with the file after it', () => {
    let q = crochet(start(emptyQueue(), soie, 3), bagdad);
    expect(now(q)).toBe('Bagdad');
    expect(places(q)).toEqual(['Tabriz', 'Bagdad', 'Maragha', 'Ayas', 'Venise']);
    q = goTo(q, q.at + 2);
    expect(now(q)).toBe('Ayas');
    expect(q.items.filter((x) => x.crochet === 'bagdad')).toHaveLength(2);
  });

  it('may only slip it in, the step now staying', () => {
    const q = crochet(start(emptyQueue(), soie, 3), bagdad, false);
    expect(now(q)).toBe('Tabriz');
    expect(stepOf(q, q.at + 1)?.step.place).toBe('Bagdad');
  });

  it('sets what came next aside when another route is taken, and takes it up again', () => {
    let q = start(start(emptyQueue(), soie, 3), polo);
    expect(places(q)).toEqual(['Tabriz', 'Venise', 'Acre', 'Khanbaliq']);
    expect(now(q)).toBe('Venise');
    expect(q.shelf).toHaveLength(1);
    expect(q.shelf[0]).toMatchObject({ title: 'soie', from: 'Tabriz' });
    q = takeShelf(goTo(q, 0), 0);
    expect(places(q)).toEqual(['Tabriz', 'Ayas', 'Venise']);
    expect(now(q)).toBe('Ayas');
    expect(q.shelf[0]?.title).toBe('polo');
  });

  it('goes to a later step of the walk played instead of starting it again', () => {
    const q = start(start(emptyQueue(), soie, 0), soie, 2);
    expect(q.items).toHaveLength(6);
    expect(now(q)).toBe('Samarcande');
    expect(start(q, soie, 2)).toBe(q);
  });

  it('adds a place from its card right after the step now', () => {
    const one = walk('card|venise', ['Venise']);
    const q = add(start(emptyQueue(), soie, 3), one);
    expect(places(q)).toEqual(['Tabriz', 'Venise', 'Ayas', 'Venise']);
    expect(now(q)).toBe('Tabriz');
    expect(q.items[1]?.added).toBe(true);
    expect(now(add(emptyQueue(), one))).toBe('Venise');
  });

  it('takes a whole crochet out from its first step, never the step now', () => {
    let q = crochet(start(emptyQueue(), soie, 3), bagdad, false);
    const first = q.items[q.at + 1]!.key;
    q = remove(q, first);
    expect(places(q)).toEqual(['Tabriz', 'Ayas', 'Venise']);
    expect(q.walks.bagdad).toBeUndefined();
    expect(remove(q, q.items[q.at]!.key)).toBe(q);
  });

  it('moves what comes next, empties it, and knows how far a walk was read', () => {
    let q = start(emptyQueue(), soie, 3);
    q = move(q, q.items[2]!.key, -1);
    expect(places(q)).toEqual(['Tabriz', 'Venise', 'Ayas']);
    expect(move(q, q.items[1]!.key, -1)).toBe(q);
    expect(progressOf(q, 'soie')).toEqual({ step: 3, done: false });
    expect(places(clearNext(q))).toEqual(['Tabriz']);
  });

  it('keeps a step written for every item of it', () => {
    const q = updateStep(start(emptyQueue(), soie, 3), 'soie', 3, { ...soie.steps[3]!, text: 'Écrit.' });
    expect(stepOf(q, q.at)?.step.text).toBe('Écrit.');
    expect(soie.steps[3]!.text).toBe('');
  });

  it('reads back what holds together, with keys that do not collide', () => {
    const q = crochet(start(emptyQueue(), soie, 3), bagdad);
    const back = parseQueue(JSON.parse(JSON.stringify({ ...q, items: [...q.items, { key: 'x', walk: 'gone', step: 0 }] })));
    expect(places(back)).toEqual(places(q));
    expect(back.at).toBe(q.at);
    const after = add(back, walk('card|acre', ['Acre']));
    expect(new Set(after.items.map((x) => x.key)).size).toBe(after.items.length);
    expect(parseQueue(null)).toEqual(emptyQueue());
  });

  it('cuts the file into its scenarios, and keeps the nearest ones', () => {
    // Tabriz (soie), Bagdad Maragha (a crochet), Ayas Venise (soie again).
    let q = goTo(crochet(start(emptyQueue(), soie, 3), bagdad), 3);
    expect(runsOf(q).map((r) => `${r.walk}:${r.from}-${r.to}${r.crochet ? '*' : ''}`)).toEqual(['soie:0-1', 'bagdad:1-3*', 'soie:3-5']);
    // The player: the scenario read and the one before it.
    expect(nearSpan(q)).toEqual({ from: 1, to: 5 });
    expect(nearSpan(goTo(q, 0))).toEqual({ from: 0, to: 1 });
    // The timeline: the one read, then those around it, the earlier first.
    q = start(q, polo);
    expect([...nearWalks(q, 3)]).toEqual(['polo', 'soie', 'bagdad']);
    expect([...nearWalks(q, 2)]).toEqual(['polo', 'soie']);
    expect([...nearWalks(goTo(q, 1), 2)]).toEqual(['bagdad', 'soie']);
  });

  it('draws the scenarios taken as a tree: crochets and routes set aside branch off', () => {
    // soie from Tabriz, a crochet to Bagdad, back to Ayas, then polo taken there (Venise set aside).
    let q = goTo(crochet(start(emptyQueue(), soie, 3), bagdad), 3);
    q = start(q, polo);
    const tree = treeOf(q);
    expect(tree.map((s) => [s.run.walk, s.turn, s.crochets.map((c) => c.walk), s.shelves])).toEqual([
      ['soie', false, ['bagdad'], []],
      ['soie', false, [], [0]],
      ['polo', true, [], []],
    ]);
    expect(q.shelf[0]!.from).toBe('Ayas');
    expect(treeOf(emptyQueue())).toEqual([]);
  });
});
