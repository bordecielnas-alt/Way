import { existsSync, readdirSync } from 'node:fs';
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
