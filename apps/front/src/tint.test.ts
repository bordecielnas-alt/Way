import { describe, expect, it } from 'vitest';
import { dominantColor, lighter, withAlpha } from './tint.ts';

/** RGBA pixels: `n` of each color. */
function pixels(...parts: [number, [number, number, number, number]][]): number[] {
  return parts.flatMap(([n, c]) => Array.from({ length: n }, () => c).flat());
}

const hue = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

describe('dominantColor', () => {
  it('takes the largest colored area, not the silver field or the outlines', () => {
    // Arms of a red lion on silver: much white, black outlines, then red.
    const c = dominantColor(pixels([60, [245, 245, 245, 255]], [15, [10, 10, 10, 255]], [25, [200, 20, 30, 255]], [5, [230, 190, 40, 255]]));
    const [r, g, b] = hue(c!);
    expect(r).toBeGreaterThan(g! + 60);
    expect(r).toBeGreaterThan(b! + 60);
  });

  it('keeps reds together on both sides of 0°', () => {
    // Bohemia: a red field shaded crimson and scarlet, a smaller gold crown.
    const c = dominantColor(pixels([20, [210, 20, 45, 255]], [20, [215, 45, 20, 255]], [30, [225, 180, 30, 255]]));
    const [r, g] = hue(c!);
    expect(r! - g!).toBeGreaterThan(120);
  });

  it('ignores transparent pixels and has no color for plain black and white', () => {
    expect(dominantColor(pixels([50, [255, 255, 255, 255]], [50, [0, 0, 0, 255]]))).toBeNull();
    expect(dominantColor(pixels([90, [0, 0, 255, 0]], [10, [20, 60, 200, 255]]))).not.toBeNull();
  });

  it('keeps the color readable on the map', () => {
    // A very dark navy comes out lighter.
    const [r, g, b] = hue(dominantColor(pixels([10, [10, 15, 60, 255]]))!);
    expect(Math.max(r!, g!, b!)).toBeGreaterThan(120);
  });

  it('formats tones', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('#ff000080');
    expect(lighter('#000000', 0.5)).toBe('#808080');
  });
});
