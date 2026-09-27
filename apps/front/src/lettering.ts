// Map lettering in the manner of grand strategy games: a realm's name is
// written across it, following its main axis on a gentle curve, its size
// set by the realm's extent. Pure geometry, drawn by the border tiles.

export type Ring = [number, number][];

export interface Glyph { ch: string; lon: number; lat: number; /** radians, counterclockwise from east */ angle: number }

export interface Lettering {
  glyphs: Glyph[];
  /** Letter height in degrees of latitude. */
  size: number;
  west: number; south: number; east: number; north: number;
}

/** Width of a character for a letter height of 1, spacing included. */
export type Measure = (ch: string) => number;

const BINS = 14;
const MAX_TILT = (30 * Math.PI) / 180;
/** Letters lean at most this much, curve included. */
const MAX_ANGLE = (45 * Math.PI) / 180;

/**
 * Places `text` along the realm drawn by `ring` (its largest outer ring).
 * Returns null when the shape is too thin or too small to hold it.
 */
export function letter(ring: Ring, text: string, measure: Measure, opts: { fill?: number; maxSize?: number } = {}): Lettering | null {
  if (ring.length < 4 || !text.trim()) return null;
  let lon0 = 0, lat0 = 0;
  for (const [x, y] of ring) { lon0 += x; lat0 += y; }
  lon0 /= ring.length;
  lat0 /= ring.length;
  const c = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  // Local plane in degrees of latitude: one unit is the same length both ways.
  const pts = ring.map(([x, y]) => [(x - lon0) * c, y - lat0] as [number, number]);

  // Main axis (principal component), tilted at most 40°, read left to right.
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += x * x; syy += y * y; sxy += x * y; }
  let alpha = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (alpha > Math.PI / 2) alpha -= Math.PI;
  if (alpha < -Math.PI / 2) alpha += Math.PI;
  alpha = Math.max(-MAX_TILT, Math.min(MAX_TILT, alpha));
  const ux = Math.cos(alpha), uy = Math.sin(alpha);
  const nx = -uy, ny = ux;
  const local = pts.map(([x, y]) => [x * ux + y * uy, x * nx + y * ny] as [number, number]);
  let tmin = Infinity, tmax = -Infinity;
  for (const [t] of local) { tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
  if (!(tmax > tmin)) return null;

  // Cross-sections: the widest inside stretch across the axis, at each step along it.
  const step = (tmax - tmin) / BINS;
  const sections: { t: number; mid: number; width: number }[] = [];
  for (let k = 0; k < BINS; k++) {
    const t = tmin + (k + 0.5) * step;
    const hits: number[] = [];
    for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
      const [ti, vi] = local[i]!;
      const [tj, vj] = local[j]!;
      if (ti > t !== tj > t) hits.push(vi + ((t - ti) * (vj - vi)) / (tj - ti));
    }
    hits.sort((a, b) => a - b);
    let best = { mid: 0, width: 0 };
    for (let h = 0; h + 1 < hits.length; h += 2) {
      const w = hits[h + 1]! - hits[h]!;
      if (w > best.width) best = { mid: (hits[h]! + hits[h + 1]!) / 2, width: w };
    }
    if (best.width > 0) sections.push({ t, ...best });
  }
  if (sections.length < 2) return null;
  const widest = Math.max(...sections.map((s) => s.width));
  // The text avoids thin tails (a peninsula, a coastal strip).
  const body = sections.filter((s) => s.width >= widest * 0.35);
  const first = body[0]!;
  const last = body[body.length - 1]!;
  const ta = first.t - step / 2;
  const tb = last.t + step / 2;
  const span = tb - ta;

  // Center line: a parabola through the sections' middles, weighted by their width.
  const [a, b, c0] = fitParabola(body.map((s) => [s.t, s.mid, s.width]));
  const tc = (ta + tb) / 2;
  // Bend no more than a gentle arc.
  const sag = Math.abs(a) * (span / 2) ** 2;
  const k = sag > span * 0.12 ? (span * 0.12) / sag : 1;
  const v = (t: number) => (a * t * t + b * t + c0) * k + (a * tc * tc + b * tc + c0) * (1 - k);
  const dv = (t: number) => (2 * a * t + b) * k;

  const chars = [...text];
  const widths = chars.map(measure);
  const total = widths.reduce((s, w) => s + w, 0);
  const thick = median(body.map((s) => s.width));
  let size = Math.min((span * (opts.fill ?? 0.8)) / total, thick * 0.55);
  if (opts.maxSize) size = Math.min(size, opts.maxSize);
  if (!(size > 0)) return null;

  // Arc length table along the center line.
  const N = 64;
  const ts: number[] = [];
  const arc: number[] = [0];
  for (let i = 0; i <= N; i++) ts.push(ta + (span * i) / N);
  for (let i = 1; i <= N; i++) arc.push(arc[i - 1]! + Math.hypot(ts[i]! - ts[i - 1]!, v(ts[i]!) - v(ts[i - 1]!)));
  const length = arc[N]!;
  const tAt = (s: number) => {
    let i = 1;
    while (i < N && arc[i]! < s) i++;
    const f = (s - arc[i - 1]!) / (arc[i]! - arc[i - 1]! || 1);
    return ts[i - 1]! + (ts[i]! - ts[i - 1]!) * Math.max(0, Math.min(1, f));
  };

  const glyphs: Glyph[] = [];
  let at = (length - total * size) / 2;
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  chars.forEach((ch, i) => {
    const w = widths[i]! * size;
    const t = tAt(at + w / 2);
    at += w;
    if (ch === ' ') return;
    const vv = v(t);
    const x = t * ux + vv * nx;
    const y = t * uy + vv * ny;
    const lat = lat0 + y;
    const lon = lon0 + x / c;
    glyphs.push({ ch, lon, lat, angle: Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, alpha + Math.atan(dv(t)))) });
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  });
  if (!glyphs.length) return null;
  const pad = size;
  return { glyphs, size, west: west - pad / c, east: east + pad / c, south: south - pad, north: north + pad };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

/** Weighted least squares y = a x² + b x + c; a straight line when too few points. */
export function fitParabola(pts: [number, number, number][]): [number, number, number] {
  if (pts.length < 3) {
    if (pts.length === 2) {
      const [[x1, y1], [x2, y2]] = pts as [[number, number, number], [number, number, number]];
      const b = x2 !== x1 ? (y2 - y1) / (x2 - x1) : 0;
      return [0, b, y1 - b * x1];
    }
    return [0, 0, pts[0]?.[1] ?? 0];
  }
  // Normal equations, 3×3.
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const r = [0, 0, 0];
  for (const [x, y, w] of pts) {
    const p = [x * x, x, 1];
    for (let i = 0; i < 3; i++) {
      r[i]! += w * p[i]! * y;
      for (let j = 0; j < 3; j++) m[i]![j]! += w * p[i]! * p[j]!;
    }
  }
  const sol = solve3(m, r);
  return sol ?? [0, 0, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

function solve3(m: number[][], r: number[]): [number, number, number] | null {
  const det = (a: number[][]) =>
    a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!)
    - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!)
    + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const col = (k: number) => m.map((row, i) => row.map((v, j) => (j === k ? r[i]! : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/** Titles dropped from names written on the map: "royaume de France" is written FRANCE. */
const TITLE = new RegExp(
  '^(?:(?:grand-duché|grande-principauté|royaume|duché|comté|principauté(?: épiscopale)?|margraviat|landgraviat|république|empire|' +
  'sultanat|émirat|khanat|califat|seigneurie|archevêché|évêché|despotat|électorat|vice-royauté|banat|tsarat|maison|duchés|principautés|' +
  'couronne|kingdom|duchy|county|principality|republic|sultanate|emirate|khanate|caliphate|grand duchy|margraviate|lordship|house|crown)' +
  ' (?:de la |de l\'|des |du |d\'|de |of the |of ))',
  'i',
);

export function shortName(name: string): string {
  const s = name.replace(TITLE, '').trim();
  return s.length >= 2 ? s.charAt(0).toUpperCase() + s.slice(1) : name;
}
