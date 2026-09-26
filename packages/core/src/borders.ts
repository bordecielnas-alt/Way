import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Downloads missing snapshots (years >= -5000) into `dir`. Idempotent: existing
 * files are kept, so it is safe to call at every startup.
 */
export async function ensureBorders(dir: string, userAgent: string): Promise<number> {
  const headers = { 'User-Agent': userAgent };
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/geojson`, { headers });
  if (!res.ok) throw new Error(`GitHub listing failed: ${res.status}`);
  const names = ((await res.json()) as { name: string }[])
    .map((f) => f.name)
    .filter((n) => {
      const m = /^world_(bc)?(\d+)\.geojson$/.exec(n);
      return m && (m[1] ? -Number(m[2]) : Number(m[2])) >= -5000;
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
