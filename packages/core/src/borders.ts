import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BorderFeature, BordersIndex, BordersPeriod } from '@way/shared';
import type { Cliopatria } from './cliopatria.ts';

// Historical borders from aourednik/historical-basemaps (GPL-3.0): snapshots
// named world_<year>.geojson or world_bc<year>.geojson.

export interface BorderSnapshot {
  year: number; // historical year
  file: string;
}

export function listSnapshots(dir: string): BorderSnapshot[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => {
      const m = /^world_(bc)?(\d+)\.geojson$/.exec(file);
      return m ? { year: m[1] ? -Number(m[2]) : Number(m[2]), file: join(dir, file) } : null;
    })
    .filter((s): s is BorderSnapshot => s !== null)
    .sort((a, b) => a.year - b.year);
}

/** Latest snapshot at or before `year` (or the earliest one). */
export function snapshotFor(snapshots: BorderSnapshot[], year: number): BorderSnapshot | null {
  let pick: BorderSnapshot | null = snapshots[0] ?? null;
  for (const s of snapshots) if (s.year <= year) pick = s;
  return pick;
}

const REPO = 'aourednik/historical-basemaps';
/** Cliopatria starts in 3400 BCE: older borders come from the snapshots. */
export const SNAPSHOTS_BEFORE = -3400;
const QUANTUM = 0.01;

type LegacyRing = [number, number][];
interface LegacyFeature {
  properties: { NAME?: string | null; SUBJECTO?: string | null; PARTOF?: string | null };
  geometry: { type: 'Polygon'; coordinates: LegacyRing[] } | { type: 'MultiPolygon'; coordinates: LegacyRing[][] } | null;
}

function encodeRing(ring: LegacyRing): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [x, y] of ring) {
    const qx = Math.round(x / QUANTUM), qy = Math.round(y / QUANTUM);
    out.push(qx - px, qy - py);
    px = qx; py = qy;
  }
  return out;
}

/**
 * Borders by year: Cliopatria's yearly polygons, and the older snapshots
 * (aourednik) before 3400 BCE, both in the same compact shape.
 */
export class BordersService {
  private legacy = new Map<number, BordersPeriod>();

  constructor(private clio: Cliopatria, private dir: string) {}

  private snapshots(): BorderSnapshot[] {
    return listSnapshots(this.dir).filter((s) => s.year < SNAPSHOTS_BEFORE);
  }

  index(): BordersIndex | null {
    const c = this.clio.index();
    const old = this.snapshots().map((s) => s.year);
    if (!c && !old.length) return null;
    return {
      version: `${c?.version ?? 'none'}+${old.length}`,
      quantum: QUANTUM,
      events: [...old, ...(c?.events ?? [])],
    };
  }

  period(year: number): BordersPeriod | null {
    const p = year >= SNAPSHOTS_BEFORE ? this.clio.period(year) : null;
    if (p) return p;
    const snaps = this.snapshots();
    const snap = snapshotFor(snaps, year);
    if (!snap) return null;
    let hit = this.legacy.get(snap.year);
    if (!hit) {
      const next = snaps.find((s) => s.year > snap.year)?.year ?? SNAPSHOTS_BEFORE;
      const geo = JSON.parse(readFileSync(snap.file, 'utf8')) as { features: LegacyFeature[] };
      const features: BorderFeature[] = [];
      geo.features.forEach((f, id) => {
        if (!f.geometry) return;
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        const name = (f.properties.NAME ?? f.properties.SUBJECTO ?? f.properties.PARTOF ?? '').trim();
        features.push({ id, name, qid: null, composite: false, parent: null, area: 0, g: polys.map((rings) => rings.map(encodeRing)) });
      });
      hit = { from: snap.year, to: next - 1, version: this.index()!.version, features };
      this.legacy.set(snap.year, hit);
    }
    return hit;
  }
}

/**
 * Downloads missing snapshots (years before 3400 BCE, down to -5000) into
 * `dir`. Idempotent: existing files are kept, so it is safe to call at every startup.
 */
export async function ensureBorders(dir: string, userAgent: string): Promise<number> {
  const headers = { 'User-Agent': userAgent };
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/geojson`, { headers });
  if (!res.ok) throw new Error(`GitHub listing failed: ${res.status}`);
  const names = ((await res.json()) as { name: string }[])
    .map((f) => f.name)
    .filter((n) => {
      const m = /^world_(bc)?(\d+)\.geojson$/.exec(n);
      const year = m ? (m[1] ? -Number(m[2]) : Number(m[2])) : NaN;
      return year >= -5000 && year < SNAPSHOTS_BEFORE;
    });
  mkdirSync(dir, { recursive: true });
  let fetched = 0;
  for (const name of names) {
    const dest = join(dir, name);
    if (existsSync(dest)) continue;
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/master/geojson/${name}`, { headers });
    if (!r.ok) throw new Error(`${name}: ${r.status}`);
    // Write to a temp name first so a crash never leaves a truncated snapshot.
    writeFileSync(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
    renameSync(`${dest}.part`, dest);
    fetched++;
  }
  return fetched;
}
