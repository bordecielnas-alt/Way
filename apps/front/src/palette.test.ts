import { describe, expect, it } from 'vitest';
import type { Ring } from './divisions.ts';
import { delta, MIN_DELTA, neighbors, separate } from './palette.ts';

const square = (x: number, y: number, w = 4): Ring => [[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]];

describe('colors of realms side by side', () => {
  // A and B share an edge, C is a strait away from B, D is far off.
  const a = { key: 'A', rings: [square(0, 0)] };
  const b = { key: 'B', rings: [square(4, 0)] };
  const c = { key: 'C', rings: [square(8.8, 0)] };
  const d = { key: 'D', rings: [square(40, 40)] };

  it('knows who touches or nearly touches whom', () => {
    const n = neighbors([a, b, c, d]);
    expect([...n.get('A')!]).toEqual(['B']);
    expect([...n.get('B')!].sort()).toEqual(['A', 'C']);
    expect(n.get('D')!.size).toBe(0);
  });

  it('gives neighbors colors far enough apart, the largest first keeping its own', () => {
    const blue = '#3a6fd0';
    const near = neighbors([a, b, c, d]);
    const out = separate([{ ...a, color: blue }, { ...b, color: '#3b70d2' }, { ...c, color: blue }, { ...d, color: blue }], near);
    expect(out.get('A')).toBe(blue);
    expect(delta(out.get('A')!, out.get('B')!)).toBeGreaterThanOrEqual(MIN_DELTA);
    expect(delta(out.get('B')!, out.get('C')!)).toBeGreaterThanOrEqual(MIN_DELTA);
    // Far from them, a realm keeps its color even if it is the same.
    expect(out.get('D')).toBe(blue);
    // A and C do not touch: C may stay blue.
    expect(out.get('C')).toBe(blue);
  });
});
