import { describe, expect, it } from 'vitest';
import type { Army, PersonJourney } from '@way/shared';
import { along, armyAt, km, presenceAt } from './journey.ts';

const paris: [number, number] = [48.85, 2.35];
const napoleon: PersonJourney = {
  qid: 'Q517', name: 'Napoléon', description: null, image: null, born: 1769.6, died: 1821.3,
  stops: [
    { kind: 'birth', label: 'Ajaccio', qid: null, lat: 41.92, lon: 8.74, start: 1769.6, end: null },
    { kind: 'study', label: 'École militaire', qid: null, lat: paris[0], lon: paris[1], start: 1784, end: 1785 },
    { kind: 'reign', label: 'empereur des Français', qid: null, lat: null, lon: null, start: 1804.4, end: 1814.3 },
    { kind: 'battle', label: "bataille d'Austerlitz", qid: null, lat: 49.13, lon: 16.76, start: 1805.92, end: null },
    { kind: 'death', label: 'Longwood House', qid: null, lat: -15.95, lon: -5.7, start: 1821.3, end: null },
  ],
};

describe('presenceAt', () => {
  it('is nowhere before birth and after death', () => {
    expect(presenceAt(napoleon, 1760, 0.5)).toBeNull();
    expect(presenceAt(napoleon, 1830, 0.5)).toBeNull();
  });

  it('studies during the studies', () => {
    const p = presenceAt(napoleon, 1784.5, 0.1)!;
    expect(p.kind).toBe('study');
    expect(p.lat).toBeCloseTo(paris[0]);
  });

  it('fights at a battle within the tolerance', () => {
    const p = presenceAt(napoleon, 1806, 0.5)!;
    expect(p.kind).toBe('battle');
    expect(p.text).toContain('Austerlitz');
  });

  it('waits with their title, then travels just before the next place', () => {
    const wait = presenceAt(napoleon, 1805, 0.1)!;
    expect(wait.kind).toBe('reign');
    expect(wait.text).toBe('empereur des Français');
    const road = presenceAt(napoleon, 1805.85, 0.01)!;
    expect(road.kind).toBe('travel');
    expect(road.lon).toBeGreaterThan(2.35);
    expect(road.lon).toBeLessThan(16.76);
  });
});

describe('armyAt', () => {
  const army: Army = {
    id: 'w:s', war: 'guerre', warQid: 'Q1', side: 'France', sideQid: 'Q2',
    battles: [
      { qid: 'Q3', label: 'bataille A', t: 1805.0, lat: 48, lon: 10, commanders: ['Ney'] },
      { qid: 'Q4', label: 'bataille B', t: 1806.0, lat: 50, lon: 20, commanders: [] },
    ],
  };
  it('fights, camps, marches', () => {
    expect(armyAt(army, 1805.01, 0.05)!.text).toBe('bataille A (Ney)');
    expect(armyAt(army, 1805.3, 0.05)!.kind).toBe('wait');
    expect(armyAt(army, 1805.97, 0.01)!.kind).toBe('travel');
    expect(armyAt(army, 1810, 0.05)).toBeNull();
  });
  it('names the battle it is fighting, so two sides there can clash', () => {
    expect(armyAt(army, 1805.003, 2 / 365)!.ref).toBe('Q3');
    expect(armyAt(army, 1805.3, 2 / 365)!.ref).toBeUndefined();
  });
});

describe('geometry', () => {
  it('measures and interpolates on the sphere', () => {
    expect(km(paris, [51.5, -0.12])).toBeGreaterThan(330);
    expect(km(paris, [51.5, -0.12])).toBeLessThan(360);
    const mid = along([0, 0], [0, 90], 0.5);
    expect(mid[1]).toBeCloseTo(45);
  });
});
