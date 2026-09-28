import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Army } from '@way/shared';
import { armyAt } from './journey.ts';
import { findRoute, GRID_H, GRID_W, LAND, pointOn, RIVER, straightRoute, WaterGrid, type Pt } from './routes.ts';
import { fineShift } from './timeline.ts';

const file = readFileSync(join(import.meta.dirname, '../public/geo/water.bin'));
const world = WaterGrid.decode(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));

/** A grid of sea with land boxes ([south, west, north, east] in degrees). */
function grid(...boxes: [number, number, number, number, number?][]): WaterGrid {
  const cells = new Uint8Array(GRID_W * GRID_H);
  for (const [s, w, n, e, kind] of boxes) {
    for (let lat = s; lat < n; lat += 0.25) {
      for (let lon = w; lon < e; lon += 0.25) {
        const [r, c] = WaterGrid.cellOf(lat + 0.1, lon + 0.1);
        cells[r * GRID_W + c] = kind ?? LAND;
      }
    }
  }
  return new WaterGrid(cells);
}

const aboard = (pts: Pt[], water: boolean[]) => pts.filter((_, i) => water[i]).length;

describe('routes', () => {
  it('reads the world: Paris is on land, the Mediterranean is sea', () => {
    expect(world.at(48.85, 2.35)).not.toBe(0);
    expect(world.at(38, 5)).toBe(0);
  });

  it('marches overland across Europe', () => {
    const r = findRoute(world, [48.85, 2.35], [55.75, 37.6])!;
    expect(r).not.toBeNull();
    expect(aboard(r.pts, r.water)).toBe(0);
    expect(r.pts[0]).toEqual([48.85, 2.35]);
    expect(r.pts[r.pts.length - 1]).toEqual([55.75, 37.6]);
  });

  it('takes ship when the sea is the way (Toulon to Alexandria)', () => {
    const r = findRoute(world, [43.12, 5.93], [31.2, 29.92])!;
    expect(r).not.toBeNull();
    expect(aboard(r.pts, r.water)).toBeGreaterThan(0);
    // Halfway, the army is at sea.
    expect(pointOn(r, 0.5).water).toBe(true);
  });

  it('goes round a small bay on foot rather than embark', () => {
    // Two shores joined by land a little to the north, a bay of sea between them.
    const g = grid([40, 0, 44, 2], [40, 3, 44, 5], [42, 0, 43, 5]);
    const r = findRoute(g, [41, 1], [41, 4])!;
    expect(aboard(r.pts, r.water)).toBe(0);
    expect(Math.max(...r.pts.map((p) => p[0]))).toBeGreaterThan(42);
  });

  it('crosses a sea between two lands aboard', () => {
    const g = grid([40, 0, 44, 2], [40, 8, 44, 10]);
    const r = findRoute(g, [42, 1], [42, 9])!;
    expect(aboard(r.pts, r.water)).toBeGreaterThan(0);
    expect(r.water[0]).toBe(false);
  });

  it('goes down a long river by boat, and only crosses a short one', () => {
    const long = grid([40, 0, 45, 30], [42, 1, 42.25, 29, RIVER]);
    const r = findRoute(long, [42.1, 1.1], [42.1, 28.9])!;
    expect(aboard(r.pts, r.water)).toBeGreaterThan(0);
    const cross = findRoute(long, [41, 10], [44, 10])!;
    expect(aboard(cross.pts, cross.water)).toBe(0);
  });

  it('without a way (the other side of the world), goes straight but aboard over the sea', () => {
    const r = straightRoute(world, [40.3, -73.8], [11.9, 79.8]);
    expect(aboard(r.pts, r.water)).toBeGreaterThan(0);
    expect(r.pts.length - aboard(r.pts, r.water)).toBeGreaterThan(1);
  });

  it('water goes faster than marching', () => {
    const r = findRoute(world, [43.12, 5.93], [31.2, 29.92])!;
    expect(r.effort).toBeLessThan(2000);
  });
});

describe('armies along their ways', () => {
  const army: Army = {
    id: 'a', war: 'Campagne d’Égypte', warQid: 'Q1', side: 'France', sideQid: 'Q142',
    battles: [
      { qid: 'Q10', label: 'Toulon', t: 1798.3, lat: 43.12, lon: 5.93, commanders: [] },
      { qid: 'Q11', label: 'Alexandrie', t: 1798.55, lat: 31.2, lon: 29.92, commanders: [] },
    ],
  };
  const way = (a: Pt, b: Pt) => findRoute(world, a, b);

  it('sails at sea, and its trail follows the way', () => {
    const p = armyAt(army, 1798.45, 0.01, way)!;
    expect(p.kind).toBe('sail');
    expect(p.text).toMatch(/Embarquée vers Alexandrie/);
    expect(p.trail.length).toBeGreaterThan(2);
  });

  it('goes straight without a grid', () => {
    expect(armyAt(army, 1798.45, 0.01)!.kind).toBe('travel');
  });
});

describe('fine drag of a short window', () => {
  it('moves by days near the grip, then faster', () => {
    const day = 1 / 365;
    expect(fineShift(8, day)).toBeCloseTo(day);
    expect(fineShift(-4, day)).toBeCloseTo(-day / 2);
    expect(fineShift(300, day)).toBeGreaterThan(0.5);
    expect(fineShift(300, day)).toBeLessThan(2);
  });
});
