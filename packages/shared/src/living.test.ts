import { describe, expect, it } from 'vitest';
import { cityAt, dropSpikes, FLOWS, flowsIn, flowView, type FlowDef, type FlowStage } from './living.ts';

describe('cities', () => {
  const rome = [-500, 100_000, -100, 400_000, 100, 450_000];

  it('grows log-linearly between two figures', () => {
    expect(cityAt(rome, -500)).toEqual({ pop: 100_000, sure: 1 });
    // Halfway in years (no year 0: -300 is 200 years after -500), halfway in orders of magnitude.
    expect(cityAt(rome, -300)!.pop).toBe(200_000);
    expect(cityAt(rome, 100)!.pop).toBe(450_000);
    // Figures centuries apart: an estimate, not a fact.
    expect(cityAt([361, 150_000, 1600, 80_000], 500)!.sure).toBe(0.5);
  });

  it('keeps the nearest figure for a while around them, less sure', () => {
    expect(cityAt(rome, -580)).toEqual({ pop: 100_000, sure: 0.5 });
    expect(cityAt(rome, -700)).toBeNull();
    expect(cityAt(rome, 140)).toEqual({ pop: 450_000, sure: 0.5 });
    expect(cityAt(rome, 200)).toBeNull();
    // Still counted in the 1950s: still there today.
    expect(cityAt([1900, 1_000_000, 1975, 5_000_000], 2020)).toEqual({ pop: 5_000_000, sure: 1 });
  });

  it('drops lone spikes of the sources', () => {
    expect(dropSpikes([1900, 1_418_000, 1914, 17_600_000, 1925, 2_085_000])).toEqual([1900, 1_418_000, 1925, 2_085_000]);
    expect(dropSpikes([1900, 100, 1950, 1000])).toEqual([1900, 100, 1950, 1000]); // growth at the end is kept
  });
});

describe('flows', () => {
  const plague: FlowDef = { id: 'p', kind: 'epidemic', title: 'P', start: 1346, end: 1353, articles: [] };
  const stage = (year: number, from: number | null): FlowStage => ({ place: 'x', lat: 0, lon: 0, year, from, note: '' });
  const flow = { stages: [stage(1346, null), stage(1347, 0), stage(1348, 1), stage(1350, 1)] };

  it('shows the stages reached, the newest hot, and the ways between them', () => {
    const v = flowView(plague, flow, 1348.5);
    expect(v.stages.map((s) => s.i)).toEqual([0, 1, 2]);
    expect(v.stages[2]!.hot).toBeGreaterThan(v.stages[0]!.hot);
    expect(v.stages[0]!.hot).toBe(0); // 2.5 years ago, an epidemic of 8 years is hot for 1.6
    expect(v.edges).toEqual([[0, 1], [1, 2]]);
  });

  it('shows nothing outside its time, but an epidemic leaves traces for a while', () => {
    expect(flowView(plague, flow, 1340).stages).toEqual([]);
    expect(flowView(plague, flow, 1355).stages).toHaveLength(4);
    expect(flowView(plague, flow, 1360).stages).toEqual([]);
    const road: FlowDef = { ...plague, kind: 'trade', start: 100, end: 200 };
    expect(flowView(road, { stages: [stage(50, null)] }, 150).stages).toHaveLength(1); // reached before: there from the start
    expect(flowView(road, { stages: [stage(50, null)] }, 250).stages).toEqual([]);
  });

  it('finds the flows of a period, and every flow has a unique id and an article', () => {
    expect(flowsIn(1347, 1348, ['epidemic']).map((f) => f.id)).toEqual(['black-death']);
    expect(flowsIn(1347, 1348, ['diffusion']).map((f) => f.id)).toContain('islam'); // diffusions stay
    expect(new Set(FLOWS.map((f) => f.id)).size).toBe(FLOWS.length);
    for (const f of FLOWS) {
      expect(f.articles.length).toBeGreaterThan(0);
      expect(f.start).toBeLessThanOrEqual(f.end);
    }
  });
});
