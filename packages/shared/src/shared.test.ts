import { describe, expect, it } from 'vitest';
import {
  bucketEnd, bucketOf, bucketsInRange, cellsForRect, formatPoiDate, formatYear, makeKey, parseKey,
  posToYear, rectAreaKm2, resolutionForArea, yearToPos, CURRENT_YEAR, MIN_YEAR, poiInWindow,
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
