import { describe, expect, it } from 'vitest';
import { bounds, clipRing, contains, divide, voronoi, type Ring } from './divisions.ts';

const area = (ring: Ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

describe('regions of a territory', () => {
  it('splits a box between two seats down the middle', () => {
    const [a, b] = voronoi([[1, 1], [3, 1]], [0, 0, 4, 2]);
    expect(area(a!)).toBeCloseTo(4);
    expect(area(b!)).toBeCloseTo(4);
    expect(Math.max(...a!.map((p) => p[0]))).toBeCloseTo(2);
  });

  it('clips a concave territory to a cell', () => {
    // An L shape; the cell keeps its left half.
    const L: Ring = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    const clipped = clipRing(L, [[0, 0], [2, 0], [2, 5], [0, 5]]);
    expect(area(clipped)).toBeCloseTo(5);
  });

  it('shares the whole territory and drops seats outside it', () => {
    const parent = bounds([[[0, 40], [10, 40], [10, 50], [0, 50]]]);
    const seat = (qid: string, lon: number, lat: number) => ({ qid, label: qid, kind: null, lon, lat });
    const regions = divide(parent, [seat('A', 2, 45), seat('B', 8, 45), seat('C', 30, 45)]);
    expect(regions.map((r) => r.qid)).toEqual(['A', 'B']);
    const total = regions.reduce((s, r) => s + r.rings.reduce((t, ring) => t + area(ring), 0), 0);
    expect(total).toBeCloseTo(100);
    expect(contains(regions[0]!, 1, 41)).toBe(true);
    expect(contains(regions[0]!, 9, 41)).toBe(false);
  });

  it('needs two seats to divide', () => {
    const parent = bounds([[[0, 0], [1, 0], [1, 1], [0, 1]]]);
    expect(divide(parent, [{ qid: 'A', label: 'A', kind: null, lon: 0.5, lat: 0.5 }])).toEqual([]);
  });
});
