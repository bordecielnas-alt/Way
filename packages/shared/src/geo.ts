import { cellToLatLng, getHexagonEdgeLengthAvg, gridDisk, latLngToCell, polygonToCells, UNITS } from 'h3-js';

/** Resolutions stored on each POI (h3_cells). */
export const POI_RESOLUTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
export const MAX_RES = 8;
/** At or below this display resolution, searches use the global time-first query. */
export const GLOBAL_SEARCH_MAX_RES = 3;
/** Target maximum number of cells covering the viewport. */
export const MAX_VIEW_CELLS = 48;

// Average hexagon area per resolution, km² (H3 docs).
const HEX_AREA_KM2 = [4357449.4, 609788.44, 86801.78, 12393.43, 1770.35, 252.9, 36.13, 5.16, 0.737];

export interface Rect { west: number; south: number; east: number; north: number } // degrees

/** Approximate area of a lon/lat rectangle, km². */
export function rectAreaKm2(r: Rect): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  let width = r.east - r.west;
  if (width < 0) width += 360;
  return R * R * Math.abs(width * toRad) * Math.abs(Math.sin(r.north * toRad) - Math.sin(r.south * toRad));
}

/** Finest resolution whose cells still cover the view with at most `maxCells` cells. */
export function resolutionForArea(areaKm2: number, maxCells = MAX_VIEW_CELLS): number {
  let res = 0;
  for (let r = 0; r <= MAX_RES; r++) if (areaKm2 / HEX_AREA_KM2[r]! <= maxCells) res = r;
  return res;
}

export function isGlobalSearchRes(res: number): boolean {
  return res <= GLOBAL_SEARCH_MAX_RES;
}

/** Circumradius of a cell at `res`, km, with a safety margin. */
export function cellRadiusKm(res: number): number {
  return getHexagonEdgeLengthAvg(res, UNITS.km) * 1.2;
}

export function cellCenter(cell: string): { lat: number; lon: number } {
  const [lat, lon] = cellToLatLng(cell);
  return { lat, lon };
}

export function cellsForPoint(lat: number, lon: number): string[] {
  return POI_RESOLUTIONS.map((r) => latLngToCell(lat, lon, r));
}

function rectCells(west: number, south: number, east: number, north: number, res: number): string[] {
  // Split into chunks narrower than 90° so H3 never sees a >180° edge.
  const out: string[] = [];
  for (let w = west; w < east; w += 90) {
    const e = Math.min(east, w + 90);
    const ring: [number, number][] = [[south, w], [south, e], [north, e], [north, w], [south, w]];
    out.push(...polygonToCells(ring, res));
  }
  return out;
}

/** H3 cells covering a view rectangle, sorted by distance to the view center. */
export function cellsForRect(r: Rect, res: number): string[] {
  const south = Math.max(-89.9, r.south);
  const north = Math.min(89.9, r.north);
  const set = new Set<string>();
  const add = (cells: string[]) => cells.forEach((c) => set.add(c));
  if (r.west <= r.east) add(rectCells(r.west, south, r.east, north, res));
  else {
    add(rectCells(r.west, south, 180, north, res));
    add(rectCells(-180, south, r.east, north, res));
  }
  // Small views may not contain any cell center: include corners and center.
  const eastU = r.east < r.west ? r.east + 360 : r.east;
  const cLon = (((r.west + eastU) / 2 + 540) % 360) - 180;
  const cLat = (south + north) / 2;
  for (const [la, lo] of [[cLat, cLon], [south, r.west], [south, r.east], [north, r.west], [north, r.east]] as const) {
    set.add(latLngToCell(la, lo, res));
  }
  const dist = (c: string) => {
    const [la, lo] = cellToLatLng(c);
    let d = Math.abs(lo - cLon);
    if (d > 180) d = 360 - d;
    return (la - cLat) ** 2 + d ** 2;
  };
  return [...set].sort((a, b) => dist(a) - dist(b));
}

/**
 * Cells exactly `k` steps outside a set of cells: the k-th ring around a
 * view, in the order of the cells it grows from (nearest to the center first).
 */
export function ringAround(cells: string[], k: number): string[] {
  if (k <= 0) return [...cells];
  const inner = new Set<string>();
  for (const c of cells) for (const x of gridDisk(c, k - 1)) inner.add(x);
  const out = new Set<string>();
  for (const c of cells) for (const x of gridDisk(c, k)) if (!inner.has(x)) out.add(x);
  return [...out];
}
