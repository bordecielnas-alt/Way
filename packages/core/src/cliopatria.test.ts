import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cliopatria } from './cliopatria.ts';
import { fileAt, fitsEra, frenchTitle, sameplace } from './polity.ts';
import { mediaSources, snapWidth } from './media.ts';
import { normalizeCache, refreshMs } from './settings.ts';

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

describe('coats of arms and flags', () => {
  const flags = [
    { file: 'Royal flag.svg', start: 1365, end: 1790 },
    { file: 'Tricolore.svg', start: 1794, end: null },
    { file: 'Undated.svg', start: null, end: null },
  ];
  it('picks the one of the era, else an undated one only for a realm of the past alive then', () => {
    expect(fileAt(flags, 1500)).toBe('Royal flag.svg');
    expect(fileAt(flags, 1900)).toBe('Tricolore.svg');
    // Undated, on an item with no end (today's country): not sourced for that year.
    expect(fileAt(flags, 1000)).toBeNull();
    expect(fileAt(flags, 1000, { start: 987, end: 1328 })).toBe('Undated.svg');
    expect(fileAt(flags, 1500, { start: 987, end: 1328 })).toBe('Royal flag.svg');
    expect(fileAt(flags.slice(2), 1400, { start: 987, end: 1328 })).toBeNull();
    expect(fileAt(flags.slice(0, 2), 1000, { start: 987, end: 1328 })).toBeNull();
  });
  it('leaves out invented emblems and names of another era', () => {
    const files = (...names: string[]) => names.map((file) => ({ file, start: null, end: null }));
    expect(fileAt(files('Fictitious Ottoman flag 3.svg'), 1806)).toBeNull();
    const uk = { start: 1801, end: null };
    const gb = { start: 1707, end: 1801 };
    expect(fileAt(files('Coat of arms of the United Kingdom (1901–1952).svg', 'Royal arms.svg'), 1806, uk)).toBeNull();
    expect(fileAt(files('Coat of arms of the United Kingdom (1901–1952).svg', 'Royal arms.svg'), 1800, gb)).toBe('Royal arms.svg');
    expect(fileAt(files('Flag of Herat until 1842.svg'), 1806)).toBe('Flag of Herat until 1842.svg');
    expect(fileAt(files('Flag of Herat until 1842.svg'), 1900)).toBeNull();
  });
  it('trusts the name over dates that contradict it', () => {
    const prussia = { start: 1701, end: 1918 };
    const dated = (file: string) => ({ file, start: 1701, end: 1918 });
    expect(fileAt([dated('Middle Arms of the Kingdom of Prussia 1873.svg')], 1806, prussia)).toBeNull();
    expect(fileAt([dated('Middle Arms of the Kingdom of Prussia 1873.svg')], 1880, prussia)).toBe('Middle Arms of the Kingdom of Prussia 1873.svg');
    expect(fileAt([{ file: 'Flag of Spain (1760–1785).svg', start: 1760, end: 1843 }], 1806)).toBeNull();
    expect(fileAt([dated('Flag of the Kingdom of Prussia (1803-1892).svg')], 1806, prussia)).toBe('Flag of the Kingdom of Prussia (1803-1892).svg');
  });
});

describe('image cache', () => {
  it('only relays Wikimedia images, at standard widths', () => {
    expect(snapWidth(200)).toBe(250);
    expect(snapWidth(5000)).toBe(1280);
    // Paths as Wikimedia builds them (checked against the live Special:FilePath redirect).
    expect(mediaSources({ file: 'Flag of Denmark.svg', width: 200 })).toEqual([
      'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Flag_of_Denmark.svg/250px-Flag_of_Denmark.svg.png',
      'https://upload.wikimedia.org/wikipedia/commons/9/9c/Flag_of_Denmark.svg',
    ]);
    expect(mediaSources({ file: '../etc/passwd', width: 64 })).toEqual([]);
    expect(mediaSources({ url: 'https://upload.wikimedia.org/a/b.jpg' })).toEqual(['https://upload.wikimedia.org/a/b.jpg']);
    expect(mediaSources({ url: 'https://example.com/a.jpg' })).toEqual([]);
    expect(mediaSources({ url: 'http://upload.wikimedia.org/a.jpg' })).toEqual([]);
  });
  it('bounds the settings', () => {
    const env = 10 * 1024 ** 3;
    expect(normalizeCache(undefined, env)).toEqual({ maxGb: 10, refreshDays: 180, images: true });
    expect(normalizeCache({ maxGb: 500 }, env).maxGb).toBe(100);
    expect(normalizeCache({ maxGb: 0.1 }, env).maxGb).toBe(0.5);
    expect(refreshMs(normalizeCache({ refreshDays: 0 }, env))).toBe(Infinity);
  });
});
