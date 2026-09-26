import { MAX_YEAR, MIN_YEAR } from './years.ts';

// Non-linear timeline scale (brief §4.2): compressed in antiquity, dilated
// in modern times. Piecewise linear: each segment gets a share of the width.
interface Segment { from: number; to: number; weight: number }

const SEGMENTS: Segment[] = [
  { from: MIN_YEAR, to: -1000, weight: 0.13 },
  { from: -1000, to: 500, weight: 0.25 },
  { from: 500, to: 1500, weight: 0.18 },
  { from: 1500, to: 1800, weight: 0.16 },
  { from: 1800, to: 1900, weight: 0.1 },
  { from: 1900, to: MAX_YEAR, weight: 0.18 },
];

const TOTAL = SEGMENTS.reduce((s, x) => s + x.weight, 0);

/** Year -> position in [0, 1]. */
export function yearToPos(year: number): number {
  const y = Math.max(MIN_YEAR, Math.min(MAX_YEAR, year));
  let acc = 0;
  for (const s of SEGMENTS) {
    if (y <= s.to) return (acc + ((y - s.from) / (s.to - s.from)) * s.weight) / TOTAL;
    acc += s.weight;
  }
  return 1;
}

/** Position in [0, 1] -> year (rounded, never 0). */
export function posToYear(pos: number): number {
  const p = Math.max(0, Math.min(1, pos)) * TOTAL;
  let acc = 0;
  for (const s of SEGMENTS) {
    if (p <= acc + s.weight) {
      const y = Math.round(s.from + ((p - acc) / s.weight) * (s.to - s.from));
      return y === 0 ? 1 : y;
    }
    acc += s.weight;
  }
  return MAX_YEAR;
}

/** Tick marks for the timeline ruler. */
export const TIMELINE_TICKS: number[] = [
  -5000, -4000, -3000, -2000, -1000, -500, 1, 500, 1000, 1500, 1600, 1700, 1800, 1850, 1900, 1950, 2000,
];
