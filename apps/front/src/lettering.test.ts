import { describe, expect, it } from 'vitest';
import { fitParabola, letter, type Ring } from './lettering.ts';

const measure = () => 0.8;

describe('letter', () => {
  it('writes along a wide realm, horizontally, inside its bounds', () => {
    const ring: Ring = [[0, 40], [20, 40], [20, 46], [0, 46], [0, 40]];
    const t = letter(ring, 'ROYAUME', measure)!;
    expect(t).not.toBeNull();
    expect(t.glyphs).toHaveLength(7);
    for (const g of t.glyphs) {
      expect(g.lon).toBeGreaterThan(0);
      expect(g.lon).toBeLessThan(20);
      expect(g.lat).toBeGreaterThan(40);
      expect(g.lat).toBeLessThan(46);
      expect(Math.abs(g.angle)).toBeLessThan(0.05);
    }
    // Left to right.
    expect(t.glyphs[0]!.lon).toBeLessThan(t.glyphs[6]!.lon);
    expect(t.size).toBeGreaterThan(0.5);
  });

  it('tilts along a diagonal realm, never more than 40°', () => {
    const ring: Ring = [[0, 0], [2, 0], [22, 20], [20, 20], [0, 0]];
    const t = letter(ring, 'ABC', measure)!;
    expect(t.glyphs[0]!.angle).toBeGreaterThan(0.3);
    expect(t.glyphs[0]!.angle).toBeLessThanOrEqual((40 * Math.PI) / 180 + 0.2);
  });

  it('skips spaces but keeps their room', () => {
    const ring: Ring = [[0, 0], [10, 0], [10, 3], [0, 3], [0, 0]];
    expect(letter(ring, 'A B', measure)!.glyphs).toHaveLength(2);
  });
});

describe('fitParabola', () => {
  it('recovers a parabola', () => {
    const [a, b, c] = fitParabola([[0, 1, 1], [1, 3, 1], [2, 9, 1], [3, 19, 1]]);
    expect(a).toBeCloseTo(2);
    expect(b).toBeCloseTo(0);
    expect(c).toBeCloseTo(1);
  });
});
