// Realistic routes: armies and travellers go round the seas on foot, take
// ship when the sea is the only (or a much shorter) way, and go down big
// rivers by boat on long stretches. Searched on a 0.25° grid of the world
// (Natural Earth, public domain, built by scripts/build-geo.ts). Pure, for tests.

export const CELL = 0.25;
export const GRID_W = 360 / CELL;
export const GRID_H = 180 / CELL;
export const SEA = 0, LAND = 1, RIVER = 2, LAKE = 3;

/** Cost of a kilometre, by way of travel (the cheapest must stay under the heuristic's factor). */
const COST = { land: 1, river: 0.75, water: 0.8 };
/** Kilometres a change of way is worth: gathering ships is a matter of weeks (20 days of march). */
const EMBARK_SEA = 400;
const EMBARK_RIVER = 80;
const LAND_AGAIN = 30;
/** Water goes faster than marching (for the time along the way). */
const WATER_SPEED = 3;
const KM_PER_CELL = CELL * 111.2;
const MAX_EXPANDED = 250_000;

export type Pt = [number, number];

/** A way from a to b: points [lat, lon], whether each was reached by water, and the time share at each. */
export interface Route {
  pts: Pt[];
  water: boolean[];
  /** Cumulative effort (water counts less than marching), 0 at the start. */
  at: number[];
  /** Total effort, in marching kilometres. */
  effort: number;
}

export class WaterGrid {
  constructor(readonly cells: Uint8Array) {}

  /** Run-length encoded bytes (value, run) as written by the build script. */
  static decode(buf: ArrayBuffer): WaterGrid {
    const b = new Uint8Array(buf);
    const cells = new Uint8Array(GRID_W * GRID_H);
    let i = 0;
    for (let k = 0; k + 1 < b.length && i < cells.length; k += 2) {
      cells.fill(b[k]!, i, i + b[k + 1]!);
      i += b[k + 1]!;
    }
    return new WaterGrid(cells);
  }

  static cellOf(lat: number, lon: number): [number, number] {
    const r = Math.min(GRID_H - 1, Math.max(0, Math.floor((90 - lat) / CELL)));
    let c = Math.floor((lon + 180) / CELL) % GRID_W;
    if (c < 0) c += GRID_W;
    return [r, c];
  }

  at(lat: number, lon: number): number {
    const [r, c] = WaterGrid.cellOf(lat, lon);
    return this.cells[r * GRID_W + c]!;
  }
}

export function km(a: Pt, b: Pt): number {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r;
  const dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Binary min-heap of node ids by priority. */
class Heap {
  private ids: number[] = [];
  private pri: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, p: number): void {
    let i = this.ids.length;
    this.ids.push(id);
    this.pri.push(p);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (this.pri[up]! <= p) break;
      this.ids[i] = this.ids[up]!;
      this.pri[i] = this.pri[up]!;
      i = up;
    }
    this.ids[i] = id;
    this.pri[i] = p;
  }
  pop(): number {
    const top = this.ids[0]!;
    const id = this.ids.pop()!;
    const p = this.pri.pop()!;
    if (this.ids.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= this.ids.length) break;
        const r = l + 1;
        const c = r < this.ids.length && this.pri[r]! < this.pri[l]! ? r : l;
        if (this.pri[c]! >= p) break;
        this.ids[i] = this.ids[c]!;
        this.pri[i] = this.pri[c]!;
        i = c;
      }
      this.ids[i] = id;
      this.pri[i] = p;
    }
    return top;
  }
}

/**
 * The cheapest way from a to b on the grid, or null (too far, across the
 * antimeridian, or no way within the search box): the caller then goes straight.
 * A node is a cell and a way of travel (on foot, or aboard).
 */
export function findRoute(grid: WaterGrid, a: Pt, b: Pt): Route | null {
  if (Math.abs(a[1] - b[1]) > 170) return null;
  const [r0, c0] = WaterGrid.cellOf(a[0], a[1]);
  const [r1, c1] = WaterGrid.cellOf(b[0], b[1]);
  if (r0 === r1 && c0 === c1) return null;
  // Search box: the two ends and a margin to go round a sea or a peninsula.
  const m = Math.max(24, Math.round(0.45 * Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0))));
  const top = Math.max(0, Math.min(r0, r1) - m);
  const bottom = Math.min(GRID_H - 1, Math.max(r0, r1) + m);
  const left = Math.max(0, Math.min(c0, c1) - m);
  const right = Math.min(GRID_W - 1, Math.max(c0, c1) + m);
  const bw = right - left + 1;
  const bh = bottom - top + 1;
  const n = bw * bh * 2;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const kind = (r: number, c: number) => grid.cells[r * GRID_W + c]!;
  const node = (r: number, c: number, boat: number) => ((r - top) * bw + (c - left)) * 2 + boat;
  const goalPt: Pt = b;
  const h = (r: number, c: number) => 0.74 * km([90 - (r + 0.5) * CELL, (c + 0.5) * CELL - 180], goalPt);
  const heap = new Heap();
  // A naval battle starts aboard.
  const k0 = kind(r0, c0);
  const start = node(r0, c0, k0 === SEA || k0 === LAKE ? 1 : 0);
  cost[start] = 0;
  heap.push(start, h(r0, c0));
  let goal = -1;
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    const boat = cur & 1;
    const cell = cur >> 1;
    const r = top + Math.floor(cell / bw);
    const c = left + (cell % bw);
    if (r === r1 && c === c1) {
      goal = cur;
      break;
    }
    if (++expanded > MAX_EXPANDED) return null;
    const lat = 90 - (r + 0.5) * CELL;
    const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < top || nr > bottom || nc < left || nc > right) continue;
        const k = kind(nr, nc);
        const d = KM_PER_CELL * Math.hypot(dr, dc * cos);
        // On foot: land and river banks (a river is crossed). Aboard: rivers, lakes, the sea.
        for (const nb of [0, 1]) {
          if (nb === 0 && k !== LAND && k !== RIVER) continue;
          if (nb === 1 && k === LAND) continue;
          let step = d * (nb === 0 ? COST.land : k === RIVER ? COST.river : COST.water);
          if (nb !== boat) step += nb ? (k === RIVER ? EMBARK_RIVER : EMBARK_SEA) : LAND_AGAIN;
          const id = node(nr, nc, nb);
          if (done[id]) continue;
          const g = cost[cur]! + step;
          if (g < cost[id]!) {
            cost[id] = g;
            from[id] = cur;
            heap.push(id, g + h(nr, nc));
          }
        }
      }
    }
  }
  if (goal < 0) return null;
  // Back from the goal, keeping the turns and the changes of way.
  const cells: { p: Pt; water: boolean }[] = [];
  for (let id = goal; id >= 0; id = from[id]!) {
    const cell = id >> 1;
    const r = top + Math.floor(cell / bw);
    const c = left + (cell % bw);
    cells.push({ p: [90 - (r + 0.5) * CELL, (c + 0.5) * CELL - 180], water: (id & 1) === 1 });
  }
  cells.reverse();
  cells[0] = { ...cells[0]!, p: a };
  cells[cells.length - 1] = { ...cells[cells.length - 1]!, p: b };
  const kept = cells.filter((x, i) => {
    if (i === 0 || i === cells.length - 1) return true;
    const prev = cells[i - 1]!;
    const next = cells[i + 1]!;
    if (prev.water !== x.water || next.water !== x.water) return true;
    const turn = (x.p[0] - prev.p[0]) * (next.p[1] - x.p[1]) - (x.p[1] - prev.p[1]) * (next.p[0] - x.p[0]);
    return Math.abs(turn) > 1e-9;
  });
  return withEffort(kept.map((x) => x.p), kept.map((x) => x.water));
}

/**
 * The great circle, when no way is found (the other side of the world): aboard
 * wherever it crosses water, so no one walks on the sea.
 */
export function straightRoute(grid: WaterGrid, a: Pt, b: Pt): Route {
  const n = Math.max(2, Math.ceil(km(a, b) / 40));
  const pts: Pt[] = [];
  const water: boolean[] = [];
  for (let i = 0; i <= n; i++) {
    const p = greatCircle(a, b, i / n);
    const k = grid.at(p[0], p[1]);
    const w = k === SEA || k === LAKE;
    // Keep the ends and the points where the way changes.
    if (i === 0 || i === n || w !== water[water.length - 1]) {
      pts.push(i === 0 ? a : i === n ? b : p);
      water.push(i === 0 ? false : w);
    }
  }
  return withEffort(pts, water);
}

function greatCircle(a: Pt, b: Pt, f: number): Pt {
  const r = Math.PI / 180;
  const toV = ([lat, lon]: Pt) => [Math.cos(lat * r) * Math.cos(lon * r), Math.cos(lat * r) * Math.sin(lon * r), Math.sin(lat * r)];
  const va = toV(a), vb = toV(b);
  const w = Math.acos(Math.min(1, Math.max(-1, va[0]! * vb[0]! + va[1]! * vb[1]! + va[2]! * vb[2]!)));
  if (w < 1e-9) return a;
  const sa = Math.sin((1 - f) * w) / Math.sin(w);
  const sb = Math.sin(f * w) / Math.sin(w);
  const v = [sa * va[0]! + sb * vb[0]!, sa * va[1]! + sb * vb[1]!, sa * va[2]! + sb * vb[2]!];
  return [Math.atan2(v[2]!, Math.hypot(v[0]!, v[1]!)) / r, Math.atan2(v[1]!, v[0]!) / r];
}

/** Adds the effort along a way: water counts for less, being faster. */
export function withEffort(pts: Pt[], water: boolean[]): Route {
  const at = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1]! + km(pts[i - 1]!, pts[i]!) / (water[i] ? WATER_SPEED : 1));
  return { pts, water, at, effort: at[at.length - 1]! };
}

/** Where one is at a share f (0..1) of the way, and whether aboard. */
export function pointOn(route: Route, f: number): { p: Pt; water: boolean; passed: Pt[] } {
  const target = Math.min(1, Math.max(0, f)) * route.effort;
  let i = 1;
  while (i < route.pts.length - 1 && route.at[i]! < target) i++;
  const a = route.pts[i - 1]!;
  const b = route.pts[i]!;
  const seg = route.at[i]! - route.at[i - 1]!;
  const k = seg > 0 ? (target - route.at[i - 1]!) / seg : 1;
  let dLon = b[1] - a[1];
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const p: Pt = [a[0] + (b[0] - a[0]) * k, a[1] + dLon * k];
  return { p, water: route.water[i]!, passed: [...route.pts.slice(0, i), p] };
}
