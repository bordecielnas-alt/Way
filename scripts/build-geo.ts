// Builds the geography files served with the globe, from Natural Earth
// (public domain, https://www.naturalearthdata.com), once:
//  - geo/water.bin: a 0.25° grid of the world, sea / land / river / lake,
//    run-length encoded (the armies' routes and their boats);
//  - geo/rivers.json: rivers and lakes, quantized, drawn by the Géographie layer.
// Run: npx tsx scripts/build-geo.ts [folder with the Natural Earth GeoJSON]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const OUT = resolve(import.meta.dirname, '../apps/front/public/geo');
const CELL = 0.25;
const W = 360 / CELL;
const H = 180 / CELL;
const SEA = 0, LAND = 1, RIVER = 2, LAKE = 3;
/** Rivers big enough to carry boats (Natural Earth rank, 1 = the largest). */
const NAVIGABLE_RANK = 5;
/** Rivers drawn on the map. */
const DRAWN_RANK = 7;
const Q = 0.01;

type Pos = [number, number];
interface Feature { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }

async function load(name: string, dir: string | undefined): Promise<Feature[]> {
  const local = dir ? join(dir, `${name}.geojson`) : '';
  const text = local && existsSync(local) ? readFileSync(local, 'utf8') : await (await fetch(`${SRC}/${name}.geojson`)).text();
  return (JSON.parse(text) as { features: Feature[] }).features;
}

const polygons = (f: Feature): Pos[][][] =>
  f.geometry.type === 'Polygon' ? [f.geometry.coordinates as Pos[][]] : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as Pos[][][]) : [];
const lines = (f: Feature): Pos[][] =>
  f.geometry.type === 'LineString' ? [f.geometry.coordinates as Pos[]] : f.geometry.type === 'MultiLineString' ? (f.geometry.coordinates as Pos[][]) : [];

/** Cells whose center is inside the rings (even-odd, row by row) get `value`. */
function fill(grid: Uint8Array, rings: Pos[][], value: number): void {
  let south = 90, north = -90;
  for (const r of rings) for (const [, y] of r) { south = Math.min(south, y); north = Math.max(north, y); }
  for (let row = Math.max(0, Math.floor((90 - north) / CELL)); row <= Math.min(H - 1, Math.ceil((90 - south) / CELL)); row++) {
    const lat = 90 - (row + 0.5) * CELL;
    const xs: number[] = [];
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i]!;
        const [xj, yj] = r[j]!;
        if (yi > lat !== yj > lat) xs.push(xi + ((lat - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k]! + 180) / CELL - 0.5));
      const c1 = Math.min(W - 1, Math.floor((xs[k + 1]! + 180) / CELL - 0.5));
      for (let c = c0; c <= c1; c++) grid[row * W + c] = value;
    }
  }
}

/** Straits narrower than a cell, opened by hand so fleets can pass ([lon, lat]). */
const STRAITS: Pos[][] = [
  [[28.95, 41.0], [29.15, 41.3]], // Bosphorus
  [[26.15, 40.0], [26.75, 40.5]], // Dardanelles
  [[12.65, 55.55], [12.6, 56.1]], // Øresund
  [[36.5, 45.2], [36.6, 45.45]], // Kerch
  [[15.6, 38.1], [15.65, 38.3]], // Messina
  [[-5.8, 35.9], [-5.3, 36.0]], // Gibraltar
];

/** Cells a line passes through get `value`, over the kind `over` only (a river mouth stays sea). */
function trace(grid: Uint8Array, line: Pos[], value: number, over = LAND): void {
  for (let i = 0; i + 1 < line.length; i++) {
    const [x0, y0] = line[i]!;
    const [x1, y1] = line[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 3)));
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      const y = y0 + ((y1 - y0) * k) / n;
      const c = Math.min(W - 1, Math.max(0, Math.floor((x + 180) / CELL)));
      const r = Math.min(H - 1, Math.max(0, Math.floor((90 - y) / CELL)));
      if (grid[r * W + c] === over) grid[r * W + c] = value;
    }
  }
}

function rle(grid: Uint8Array): Buffer {
  const out: number[] = [];
  for (let i = 0; i < grid.length;) {
    const v = grid[i]!;
    let n = 1;
    while (n < 255 && i + n < grid.length && grid[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return Buffer.from(out);
}

/** Quantized, delta-encoded coordinates, with points closer than a quantum dropped. */
function pack(line: Pos[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [x, y] of line) {
    const qx = Math.round(x / Q);
    const qy = Math.round(y / Q);
    if (out.length && qx === px && qy === py) continue;
    out.push(qx - px, qy - py);
    px = qx;
    py = qy;
  }
  return out;
}

/** Douglas-Peucker in degrees: rivers at map scale need few points. */
function simplify(line: Pos[], tol: number): Pos[] {
  if (line.length < 3) return line;
  let max = 0, at = 0;
  const [ax, ay] = line[0]!;
  const [bx, by] = line[line.length - 1]!;
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  for (let i = 1; i < line.length - 1; i++) {
    const [x, y] = line[i]!;
    const d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / len;
    if (d > max) { max = d; at = i; }
  }
  if (max <= tol) return [line[0]!, line[line.length - 1]!];
  return [...simplify(line.slice(0, at + 1), tol).slice(0, -1), ...simplify(line.slice(at), tol)];
}

const dir = process.argv[2];
const [land, lakes, rivers] = await Promise.all([
  load('ne_50m_land', dir), load('ne_50m_lakes', dir), load('ne_50m_rivers_lake_centerlines', dir),
]);
const grid = new Uint8Array(W * H);
for (const f of land) for (const p of polygons(f)) fill(grid, p, LAND);
for (const f of lakes) for (const p of polygons(f)) fill(grid, p, LAKE);
for (const f of rivers) {
  if (f.properties.featurecla !== 'River' || Number(f.properties.scalerank) > NAVIGABLE_RANK) continue;
  for (const l of lines(f)) trace(grid, l, RIVER);
}
for (const s of STRAITS) trace(grid, s, SEA);
mkdirSync(OUT, { recursive: true });
const bin = rle(grid);
writeFileSync(join(OUT, 'water.bin'), bin);

const drawn = {
  q: Q,
  rivers: rivers
    .filter((f) => f.properties.featurecla === 'River' && Number(f.properties.scalerank) <= DRAWN_RANK)
    .flatMap((f) => lines(f).map((l) => [Number(f.properties.scalerank), ...pack(simplify(l, 0.02))])),
  lakes: lakes.flatMap((f) => polygons(f).map((p) => pack(simplify(p[0]!, 0.02)))).filter((r) => r.length >= 6),
};
const json = JSON.stringify(drawn);
writeFileSync(join(OUT, 'rivers.json'), json);
const count = (v: number) => grid.reduce((n, x) => n + (x === v ? 1 : 0), 0);
console.log(`water.bin ${bin.length} bytes (land ${count(LAND)}, river ${count(RIVER)}, lake ${count(LAKE)}); rivers.json ${json.length} bytes`);
