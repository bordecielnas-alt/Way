import { describe, expect, it } from 'vitest';
import { distanceKm, formatDistance, formatYears } from './doors.ts';
import {
  bucketEnd, bucketOf, bucketsInRange, cellsForRect, formatPoiDate, formatYear, makeKey, parseKey,
  dateToDecimal, decimalToDate, formatDay, posToDecimalYear, DAY,
  posToYear, rectAreaKm2, recitOf, resolutionForArea, yearToPos, CURRENT_YEAR, MIN_YEAR, poiInWindow,
} from './index.ts';

describe('time buckets', () => {
  it('uses the fixed tier sizes', () => {
    expect(bucketOf(-4999)).toBe(-5000);
    expect(bucketOf(-753)).toBe(-800);
    expect(bucketEnd(-800)).toBe(-750);
    expect(bucketOf(1789)).toBe(1780);
    expect(bucketOf(1815)).toBe(1815);
    expect(bucketOf(1914)).toBe(1914);
    expect(bucketEnd(1914)).toBe(1915);
    expect(bucketOf(-9999)).toBe(MIN_YEAR);
  });

  it('lists the buckets overlapping a window', () => {
    expect(bucketsInRange(-500, -300)).toEqual([-500, -450, -400, -350, -300]);
    expect(bucketsInRange(1495, 1512)).toEqual([1475, 1500, 1510]);
  });
});

describe('french formatting', () => {
  it('formats years and precisions', () => {
    expect(formatYear(-450)).toBe('450 av. J.-C.');
    expect(formatYear(1789)).toBe('1789');
    expect(formatPoiDate(-753, null, 'exact_year')).toBe('753 av. J.-C.');
    expect(formatPoiDate(-800, null, 'century')).toBe('VIIIᵉ siècle av. J.-C.');
    expect(formatPoiDate(50, null, 'century')).toBe('Iᵉʳ siècle');
    expect(formatPoiDate(-2500, null, 'approximate')).toBe('vers 2500 av. J.-C.');
    expect(formatPoiDate(1914, 1918, 'exact_year')).toBe('1914 – 1918');
  });
});

describe('non-linear timeline', () => {
  it('maps the ends and round-trips', () => {
    expect(yearToPos(MIN_YEAR)).toBe(0);
    expect(yearToPos(CURRENT_YEAR)).toBeCloseTo(1);
    for (const y of [-3000, -500, 800, 1650, 1850, 1969]) {
      expect(Math.abs(posToYear(yearToPos(y)) - y)).toBeLessThanOrEqual(1);
    }
  });

  it('dilates modern times', () => {
    const antiquity = yearToPos(-3000) - yearToPos(-4000);
    const modern = yearToPos(2000) - yearToPos(1900);
    expect(modern).toBeGreaterThan(antiquity * 3);
  });
});

describe('h3 view helpers', () => {
  it('keeps the viewport under the cell budget', () => {
    const paris = { west: 2.2, south: 48.8, east: 2.5, north: 48.95 };
    const res = resolutionForArea(rectAreaKm2(paris));
    const cells = cellsForRect(paris, res);
    expect(res).toBeGreaterThanOrEqual(6);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(80);
  });

  it('handles the antimeridian and whole-globe views', () => {
    const pacific = { west: 170, south: -20, east: -170, north: 0 };
    expect(cellsForRect(pacific, 2).length).toBeGreaterThan(0);
    const world = { west: -180, south: -90, east: 180, north: 90 };
    expect(resolutionForArea(rectAreaKm2(world))).toBe(0);
    expect(cellsForRect(world, 0).length).toBeGreaterThan(100);
  });
});

describe('keys and windows', () => {
  it('round-trips keys', () => {
    expect(parseKey(makeKey('g', -800))).toEqual({ space: 'g', bucket: -800, filter: 'all' });
  });

  it('tests window overlap', () => {
    expect(poiInWindow({ date_start: -27, date_end: 476 }, 100, 200)).toBe(true);
    expect(poiInWindow({ date_start: -753, date_end: null }, -700, -600)).toBe(false);
  });
});

describe('door formatting', () => {
  it('formats distances with a direction', () => {
    const athens = { lat: 37.98, lon: 23.73 };
    expect(Math.round(distanceKm(athens, { lat: 41.9, lon: 12.5 }))).toBeGreaterThan(1000);
    expect(formatDistance(athens, { lat: 39.9, lon: 116.4 }).endsWith('km au nord-est')).toBe(true); // great-circle initial bearing
    expect(formatDistance(athens, { lat: 38.03, lon: 23.73 })).toBe('à 6 km au nord');
  });

  it('rounds years', () => {
    expect(formatYears(1)).toBe('un an');
    expect(formatYears(-37)).toBe('37 ans');
    expect(formatYears(98)).toBe('98 ans');
    expect(formatYears(101)).toBe('un siècle');
    expect(formatYears(1487).replace(/\s/g, ' ')).toBe('1 500 ans');
  });
});

describe('days', () => {
  it('turns dates into decimal years and back', () => {
    expect(dateToDecimal(1805, 12, 2)).toBeCloseTo(1805 + 335 / 365);
    expect(decimalToDate(dateToDecimal(1805, 12, 2))).toEqual({ year: 1805, month: 12, day: 2 });
    expect(decimalToDate(dateToDecimal(1805, 1, 31) + DAY)).toEqual({ year: 1805, month: 2, day: 1 });
    expect(decimalToDate(dateToDecimal(-44, 3, 15))).toEqual({ year: -44, month: 3, day: 15 });
  });
  it('writes them in French', () => {
    expect(formatDay(dateToDecimal(1805, 12, 2))).toBe('2 déc. 1805');
    expect(formatDay(dateToDecimal(-44, 3, 1))).toBe('1er mars 44 av. J.-C.');
  });
  it('places days on the timeline', () => {
    const t = dateToDecimal(1805, 12, 2);
    expect(posToDecimalYear(yearToPos(t))).toBeCloseTo(t, 6);
  });
});

describe('a step told short', () => {
  const text = 'Capitale des Ilkhans, Tabriz voit arriver la soie de la Caspienne. Les marchands génois et vénitiens y achètent ce que les caravanes apportent d’Asie centrale. Abaqa y tient sa cour. Le commerce enrichit la ville.\n\nUn second paragraphe.';

  it('keeps the writer’s own', () => {
    expect(recitOf({ recit: 'Deux phrases.', text })).toBe('Deux phrases.');
  });

  it('else takes whole sentences of the first paragraph, enough to read and no more', () => {
    const r = recitOf({ text });
    expect(r.startsWith('Capitale des Ilkhans')).toBe(true);
    expect(r.endsWith('Asie centrale.')).toBe(true);
    expect(r).not.toContain('second');
  });

  it('cuts a sentence too long at a word', () => {
    const r = recitOf({ text: `${'mot '.repeat(120)}fin.` });
    expect(r.length).toBeLessThanOrEqual(320);
    expect(r.endsWith('…')).toBe(true);
  });
});
