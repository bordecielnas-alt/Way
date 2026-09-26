// Year conventions: all years in the app are *historical* years with no year 0
// (-753 = 753 BC, 1 = AD 1). Wikidata RDF uses astronomical numbering
// (0 = 1 BC), so convert at the boundary with astroToHist / histToAstro.

export const MIN_YEAR = -5000;
export const CURRENT_YEAR = new Date().getFullYear();
export const MAX_YEAR = CURRENT_YEAR;

export interface Tier {
  start: number; // inclusive
  end: number; // exclusive
  step: number; // bucket size in years
}

/** Fixed time buckets (brief §5.4). */
export const TIERS: readonly Tier[] = [
  { start: -5000, end: -1000, step: 250 },
  { start: -1000, end: 500, step: 50 },
  { start: 500, end: 1500, step: 25 },
  { start: 1500, end: 1800, step: 10 },
  { start: 1800, end: 1900, step: 5 },
  { start: 1900, end: MAX_YEAR + 1, step: 1 },
];

export function clampYear(y: number): number {
  return Math.max(MIN_YEAR, Math.min(MAX_YEAR, Math.round(y)));
}

function tierOf(y: number): Tier {
  const cy = clampYear(y);
  for (const t of TIERS) if (cy >= t.start && cy < t.end) return t;
  return TIERS[TIERS.length - 1]!;
}

/** Start year of the bucket containing `y` (used as the bucket id). */
export function bucketOf(y: number): number {
  const cy = clampYear(y);
  const t = tierOf(cy);
  return t.start + Math.floor((cy - t.start) / t.step) * t.step;
}

/** Exclusive end year of the bucket starting at `b`. */
export function bucketEnd(b: number): number {
  return Math.min(b + tierOf(b).step, MAX_YEAR + 1);
}

/** All bucket ids overlapping the inclusive year range [t0, t1]. */
export function bucketsInRange(t0: number, t1: number): number[] {
  const out: number[] = [];
  let b = bucketOf(Math.min(t0, t1));
  const last = bucketOf(Math.max(t0, t1));
  while (b <= last) {
    out.push(b);
    b = bucketEnd(b);
  }
  return out;
}

export function histToAstro(y: number): number {
  return y < 0 ? y + 1 : y;
}

export function astroToHist(a: number): number {
  return a <= 0 ? a - 1 : a;
}

// ---------- French formatting ----------

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function toRoman(n: number): string {
  let s = '';
  for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
  return s;
}

const BC = ' av. J.-C.';

/** "450 av. J.-C." / "1789" */
export function formatYear(y: number): string {
  return y < 0 ? `${-y}${BC}` : `${y}`;
}

function ordinal(n: number, roman: string): string {
  return n === 1 ? `${roman}ᵉʳ` : `${roman}ᵉ`;
}

export function formatCentury(y: number): string {
  const c = Math.ceil(Math.abs(y) / 100) || 1;
  return `${ordinal(c, toRoman(c))} siècle${y < 0 ? BC : ''}`;
}

export function formatMillennium(y: number): string {
  const m = Math.ceil(Math.abs(y) / 1000) || 1;
  return `${ordinal(m, toRoman(m))} millénaire${y < 0 ? BC : ''}`;
}

export type DatePrecisionName = 'exact_year' | 'decade' | 'century' | 'millennium' | 'approximate';

export function formatPoiDate(start: number, end: number | null | undefined, precision: DatePrecisionName): string {
  let s: string;
  switch (precision) {
    case 'century': s = formatCentury(start); break;
    case 'millennium': s = formatMillennium(start); break;
    case 'decade': s = start >= 0 ? `années ${Math.floor(start / 10) * 10}` : `vers ${formatYear(start)}`; break;
    case 'approximate': s = `vers ${formatYear(start)}`; break;
    default: s = formatYear(start);
  }
  if (end != null && end !== start && precision === 'exact_year') {
    s = start < 0 && end < 0 ? `${-start} – ${formatYear(end)}` : `${formatYear(start)} – ${formatYear(end)}`;
  }
  return s;
}
