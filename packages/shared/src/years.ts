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

/** Bucket size (years) at year `y`: a natural time resolution for that era. */
export function bucketStep(y: number): number {
  return tierOf(y).step;
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

// ---------- days: decimal years ----------
// A day is 1/365 of a year (leap days ignored): 1805.92 ≈ 2 December 1805.

const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const DAY = 1 / 365;

/** Decimal year of a date (month and day from 1). */
export function dateToDecimal(year: number, month = 1, day = 1): number {
  const m = Math.min(12, Math.max(1, month));
  return year + (MONTH_START[m - 1]! + Math.min(31, Math.max(1, day)) - 1) / 365;
}

/** Year, month (1-12) and day of a decimal year; no year 0 (it counts as 1). */
export function decimalToDate(t: number): { year: number; month: number; day: number } {
  const y = Math.floor(t);
  const doy = Math.min(364, Math.max(0, Math.floor((t - y) * 365 + 1e-6)));
  let m = 0;
  while (m < 11 && MONTH_START[m + 1]! <= doy) m++;
  return { year: y === 0 ? 1 : y, month: m + 1, day: doy - MONTH_START[m]! + 1 };
}

/** "2 déc. 1805", "1er mars 44 av. J.-C." */
export function formatDay(t: number): string {
  const { year, month, day } = decimalToDate(t);
  return `${day === 1 ? '1er' : day} ${MONTHS_FR[month - 1]} ${formatYear(year)}`;
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
