import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cliopatria } from './cliopatria.ts';
import { fitsEra, frenchTitle, sameplace } from './polity.ts';

const square = [[[0, 0, 100, 0, 0, 100, -100, 0, 0, -100]]];

function fixture(): Cliopatria {
  const dir = mkdtempSync(join(tmpdir(), 'clio-'));
  const file = join(dir, 'borders.json');
  writeFileSync(file, JSON.stringify({
    built: 'test', quantum: 0.01,
    features: [
      { n: '(Kingdom of France)', f: 1290, t: 1310, q: 'Q70972', k: 'c', m: [], a: 500, g: square },
      { n: 'Kingdom of France', f: 1290, t: 1310, q: 'Q70972', k: 'p', m: ['(Kingdom of France)'], a: 200, g: square },
      { n: 'Duchy of Brittany', f: 1290, t: 1300, q: 'Q1', k: 'p', m: ['(Kingdom of France)'], a: 30, g: square },
      { n: 'Allegiance', f: 1290, t: 1310, q: null, k: 'r', m: [], a: 900, g: square },
      { n: 'Song', f: 960, t: 1127, q: 'Q7462', k: 'p', m: [], a: 900, g: square },
      { n: 'Southern Song', f: 1127, t: 1279, q: 'Q7462', k: 'p', m: [], a: 900, g: square },
    ],
  }));
  return new Cliopatria(file);
}

describe('Cliopatria', () => {
  it('finds the period where borders stay the same', () => {
    const c = fixture();
    expect(c.periodOf(1295)).toEqual({ from: 1290, to: 1300 });
    expect(c.periodOf(1305)).toEqual({ from: 1301, to: 1310 });
    expect(c.periodOf(500)).toBeNull();
  });

  it('nests members under their composite realm, and leaves relations out', () => {
    const p = fixture().period(1295)!;
    const names = p.features.map((f) => f.name);
    expect(names).toEqual(['Kingdom of France', 'Kingdom of France', 'Duchy of Brittany']);
    const realm = p.features.find((f) => f.composite)!;
    expect(realm.parent).toBeNull();
    expect(p.features.filter((f) => f.parent === realm.id)).toHaveLength(2);
    // Brittany is gone once its years are over.
    expect(fixture().period(1305)!.features.map((f) => f.name)).not.toContain('Duchy of Brittany');
  });

  it('knows an item used under several names', () => {
    const c = fixture();
    expect(c.ambiguous('Q7462')).toBe(true);
    expect(c.ambiguous('Q1')).toBe(false);
  });
});

describe('frenchTitle', () => {
  it('puts titles in French and keeps the place', () => {
    expect(frenchTitle('Duchy of Athens')).toBe("duché d'Athens");
    expect(frenchTitle('Kingdom of Naples')).toBe('royaume de Naples');
    expect(frenchTitle('Kamakura Shogunate')).toBe('shogunat Kamakura');
    expect(frenchTitle('Swedish Empire')).toBe('Swedish Empire');
    expect(frenchTitle('Venice')).toBe('Venice');
  });
});

describe('fitsEra', () => {
  it('rejects an item from another era', () => {
    expect(fitsEra(1815, 1830, 1300)).toBe(false);
    expect(fitsEra(987, 1792, 1300)).toBe(true);
    expect(fitsEra(null, null, 1300)).toBe(true);
    expect(fitsEra(1320, null, 1300)).toBe(true); // within the slack
  });
});

describe('sameplace', () => {
  it('catches an office linked instead of the realm', () => {
    expect(sameplace('Sultanate of Bone', 'sultan')).toBe(false);
    expect(sameplace('Swedish Empire', 'Swedish Empire')).toBe(true);
    expect(sameplace('Kingdom of Portugal', 'Kingdom of Portugal')).toBe(true);
    expect(sameplace('Morocco', null)).toBe(true);
  });
});
