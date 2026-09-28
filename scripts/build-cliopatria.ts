// Builds the compact yearly borders file from Cliopatria (Seshat Global History
// Databank, CC BY 4.0): polities from 3400 BCE to 2024 with their years of
// validity, composite realms and their members. Run at image build time
// (and once in dev): `npm run borders:fetch`.
//
// Output: data/cliopatria/borders.json — geometry simplified (~1 km) and
// quantized to 0.01°, rings delta-encoded as integers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const URL_ZIP = 'https://github.com/Seshat-Global-History-Databank/cliopatria/raw/main/cliopatria.geojson.zip';
const OUT = process.argv[2] ?? fileURLToPath(new URL('../data/cliopatria/borders.json', import.meta.url));
const TOLERANCE = 0.015; // degrees
const Q = 100; // 0.01° grid

type Ring = [number, number][];
interface Props {
  Name: string; FromYear: number; ToYear: number; Area: number; Type: string; Wikidata: string; MemberOf: string;
}
interface Feature { properties: Props; geometry: { type: string; coordinates: unknown } | null }

/** The one .geojson entry of a zip archive (central directory parsing, no dependency). */
function unzipGeojson(zip: Buffer): string {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('.geojson') || name.includes('__MACOSX')) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
  }
  throw new Error('no .geojson in the archive');
}

/** Douglas–Peucker on one ring (iterative). */
function simplify(ring: Ring, tol: number): Ring {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = ring[a]!;
    const [bx, by] = ring[b]!;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = ring[i]!;
      const d = len > 1e-12 ? Math.abs(dy * x - dx * y + bx * ay - by * ax) / len : Math.hypot(x - ax, y - ay);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/** Quantized, delta-encoded ring; null when it collapses. */
function encode(ring: Ring): number[] | null {
  const out: number[] = [];
  let px = 0, py = 0, n = 0;
  for (const [x, y] of ring) {
    const qx = Math.round(x * Q), qy = Math.round(y * Q);
    if (n > 0 && qx === px && qy === py) continue;
    out.push(qx - px, qy - py);
    px = qx; py = qy; n++;
  }
  return n >= 4 ? out : null;
}

function polygons(g: Feature['geometry']): Ring[][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as Ring[]];
  if (g.type === 'MultiPolygon') return g.coordinates as Ring[][];
  return [];
}

console.log('downloading Cliopatria…');
const res = await fetch(URL_ZIP, { headers: { 'User-Agent': 'Orbis/0.1 (personal history globe)' } });
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const geo = JSON.parse(unzipGeojson(Buffer.from(await res.arrayBuffer()))) as { features: Feature[] };

const out = [];
for (const f of geo.features) {
  const p = f.properties;
  const g: number[][][] = [];
  for (const poly of polygons(f.geometry)) {
    const rings = poly.map((r) => encode(simplify(r, TOLERANCE))).filter((r): r is number[] => r !== null);
    // A polygon whose outer ring collapsed is too small to draw.
    if (rings.length && encode(simplify(poly[0]!, TOLERANCE))) g.push(rings);
  }
  if (!g.length) continue;
  out.push({
    n: p.Name.trim(),
    f: p.FromYear,
    t: p.ToYear,
    q: /^Q\d+$/.test(p.Wikidata ?? '') ? p.Wikidata : null,
    k: p.Type === 'RELATION' ? 'r' : p.Name.startsWith('(') ? 'c' : 'p',
    m: p.MemberOf ? p.MemberOf.split(';').map((s) => s.trim()).filter(Boolean) : [],
    a: Math.round(p.Area),
    g,
  });
}
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify({
  source: 'Cliopatria, Seshat Global History Databank (CC BY 4.0)',
  built: new Date().toISOString().slice(0, 10),
  quantum: 1 / Q,
  features: out,
});
writeFileSync(OUT, json);
console.log(`${out.length} features, ${(json.length / 1048576).toFixed(1)} MB → ${OUT}`);
