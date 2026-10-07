import type { Ring } from './divisions.ts';
import { hslToHex } from './tint.ts';

// Realms side by side must not wear the same color. Who touches whom is read
// from their outlines on a coarse grid (touching or close by: a strait, a
// thin buffer state), then each realm, the largest first, keeps its color
// unless a neighbor already colored wears one too close; it then takes the
// hue farthest from all its neighbors'. Pure, for tests.

/** A realm to color: its key, its outlines, its color as wished (its emblem's, else its own hue). */
export interface Patch {
  key: string;
  rings: Ring[];
  color: string;
}

/** Grid step, in degrees: realms whose outlines pass within about one cell of each other are neighbors. */
const CELL_DEG = 1;
/** Below this distance (CIE76 ΔE) two neighbors' colors are taken for one another. */
export const MIN_DELTA = 28;
/** Hues tried for a realm that must change: lightness and saturation stay those of the map. */
const HUES = Array.from({ length: 36 }, (_, k) => k * 10);
const ALT_S = 0.55;
const ALT_L = 0.52;

const cell = (lon: number, lat: number) => `${Math.floor(lon / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`;

/** The grid cells an outline passes through (long edges walked step by step). */
function cellsOf(rings: Ring[]): Set<string> {
  const out = new Set<string>();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (CELL_DEG / 2)));
      for (let k = 0; k < n; k++) out.add(cell(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
    }
  }
  return out;
}

/** Which realms touch or nearly touch: their outlines share a grid cell, or two cells side by side. */
export function neighbors(patches: { key: string; rings: Ring[] }[]): Map<string, Set<string>> {
  const at = new Map<string, Set<string>>();
  const own = new Map<string, Set<string>>();
  for (const p of patches) {
    const cells = own.get(p.key) ?? own.set(p.key, new Set()).get(p.key)!;
    for (const c of cellsOf(p.rings)) {
      cells.add(c);
      (at.get(c) ?? at.set(c, new Set()).get(c)!).add(p.key);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const [key, cells] of own) {
    const near = new Set<string>();
    for (const c of cells) {
      const [x, y] = c.split(',').map(Number) as [number, number];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) for (const k of at.get(`${x + dx},${y + dy}`) ?? []) if (k !== key) near.add(k);
      }
    }
    out.set(key, near);
  }
  return out;
}

/** A color in CIE Lab (D65), for distances as the eye sees them. */
function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** How different two colors look (CIE76 ΔE). */
export function delta(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * Colors such that no two neighbors look alike: `patches` in order of
 * precedence (the largest realm first keeps its color); a realm too close
 * to a neighbor already colored takes the hue nearest its own that stands
 * apart from all of them, else the one farthest from them.
 */
export function separate(patches: Patch[], near: Map<string, Set<string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of patches) {
    if (out.has(p.key)) continue;
    const taken = [...(near.get(p.key) ?? [])].flatMap((k) => (out.has(k) ? [out.get(k)!] : []));
    const worst = (c: string) => taken.reduce((m, t) => Math.min(m, delta(c, t)), Infinity);
    if (worst(p.color) >= MIN_DELTA) {
      out.set(p.key, p.color);
      continue;
    }
    const tries = HUES.map((h) => hslToHex(h, ALT_S, ALT_L)).map((c) => ({ c, apart: worst(c), own: delta(c, p.color) }));
    const fits = tries.filter((t) => t.apart >= MIN_DELTA).sort((a, b) => a.own - b.own)[0];
    out.set(p.key, (fits ?? tries.sort((a, b) => b.apart - a.apart)[0]!).c);
  }
  return out;
}
