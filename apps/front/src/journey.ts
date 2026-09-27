// Where someone is, and what they are doing, at a moment: between two known
// places they wait, then travel at the pace of the time; a dated event
// (battle, coronation) holds them there for a while. Pure, for tests.

import type { ActivityKind, Army, JourneyStop, PersonJourney } from '@way/shared';

export interface Presence {
  lat: number;
  lon: number;
  kind: ActivityKind;
  /** What they are doing, in French. */
  text: string;
  /** The event under way (a battle's item), when there is one: two armies at the same one clash. */
  ref?: string;
  /** Places passed so far (for the trail), oldest first. */
  trail: [number, number][];
}

/** Kilometres a person covers in a year of travel (a few weeks for a long ride). */
const PERSON_KM_PER_YEAR = 6000;
const ARMY_KM_PER_YEAR = 3000;
/** Events stand out over the stays around them. */
const EVENT_RANK: Partial<Record<ActivityKind, number>> = {
  battle: 6, coronation: 5, marriage: 4, death: 4, birth: 3, event: 2,
};

type Placed = JourneyStop & { lat: number; lon: number };

export function km(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r;
  const dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point along the great circle from a to b ([lat, lon], f in 0..1). */
export function along(a: [number, number], b: [number, number], f: number): [number, number] {
  const r = Math.PI / 180;
  const toV = ([lat, lon]: [number, number]) => [Math.cos(lat * r) * Math.cos(lon * r), Math.cos(lat * r) * Math.sin(lon * r), Math.sin(lat * r)];
  const va = toV(a), vb = toV(b);
  const dot = Math.min(1, Math.max(-1, va[0]! * vb[0]! + va[1]! * vb[1]! + va[2]! * vb[2]!));
  const w = Math.acos(dot);
  if (w < 1e-9) return a;
  const sa = Math.sin((1 - f) * w) / Math.sin(w);
  const sb = Math.sin(f * w) / Math.sin(w);
  const v = [sa * va[0]! + sb * vb[0]!, sa * va[1]! + sb * vb[1]!, sa * va[2]! + sb * vb[2]!];
  return [Math.atan2(v[2]!, Math.hypot(v[0]!, v[1]!)) / r, Math.atan2(v[1]!, v[0]!) / r];
}

const endOf = (s: JourneyStop) => s.end ?? s.start;

function describe(s: JourneyStop): string {
  switch (s.kind) {
    case 'birth': return `Naissance à ${s.label}`;
    case 'death': return `Mort à ${s.label}`;
    case 'study': return `Études : ${s.label}`;
    case 'stay': return `Séjour : ${s.label}`;
    case 'work': return `Travail : ${s.label}`;
    case 'reign': return `Règne : ${s.label}`;
    case 'office': return s.label;
    case 'battle': return s.label;
    case 'coronation': return /sacre|couronnement/i.test(s.label) ? s.label : `Couronnement : ${s.label}`;
    case 'marriage': return s.label;
    default: return s.label;
  }
}

/**
 * Presence at `t` (decimal year); `tol` is how long an event holds someone
 * (a fraction of the window shown, so yearly steps still catch battles).
 * Null before birth and after death.
 */
export function presenceAt(j: PersonJourney, t: number, tol: number): Presence | null {
  const born = j.born ?? j.stops[0]?.start ?? null;
  if (born === null || t < born - 0.01) return null;
  if (j.died !== null && t > j.died + tol) return null;
  const placed = j.stops.filter((s): s is Placed => s.lat !== null && s.lon !== null);
  if (!placed.length) return null;
  const trail = placed.filter((s) => s.start <= t).map((s): [number, number] => [s.lat, s.lon]);

  // Unplaced titles held at that time (emperor, consul) describe the waiting.
  const status = j.stops
    .filter((s) => s.lat === null && (s.kind === 'reign' || s.kind === 'office') && s.start <= t && t <= (s.end ?? s.start + 1))
    .sort((a, b) => b.start - a.start)[0];

  // A dated event close enough: there, doing that.
  const event = placed
    .filter((s) => s.end === null && EVENT_RANK[s.kind] !== undefined && Math.abs(t - s.start) <= tol)
    .sort((a, b) => (EVENT_RANK[b.kind]! - EVENT_RANK[a.kind]!) || Math.abs(t - a.start) - Math.abs(t - b.start))[0];
  if (event) return { lat: event.lat, lon: event.lon, kind: event.kind, text: describe(event), ref: event.qid ?? undefined, trail: [...trail, [event.lat, event.lon]] };

  // A stay under way (studies, a residence, a reign in its capital).
  const stay = placed
    .filter((s) => s.end !== null && s.start <= t && t <= s.end)
    .sort((a, b) => b.start - a.start)[0];
  const prev = placed.filter((s) => endOf(s) <= t).sort((a, b) => endOf(b) - endOf(a))[0];
  const next = placed.filter((s) => s.start > t).sort((a, b) => a.start - b.start)[0];

  // Leaving for the next place in time: on the road.
  const from = stay ?? prev;
  if (from && next) {
    const a: [number, number] = [from.lat, from.lon];
    const b: [number, number] = [next.lat, next.lon];
    const dist = km(a, b);
    const gap = next.start - Math.max(endOf(from), from.start);
    const travel = Math.min(Math.max(gap, 0.001), Math.max(0.02, dist / PERSON_KM_PER_YEAR));
    if (dist > 30 && t >= next.start - travel) {
      const f = Math.min(1, Math.max(0, (t - (next.start - travel)) / travel));
      const [lat, lon] = along(a, b, f);
      return { lat, lon, kind: 'travel', text: `En route vers ${placeName(next)}`, trail: [...trail, [lat, lon]] };
    }
  }
  if (stay) return { lat: stay.lat, lon: stay.lon, kind: stay.kind, text: status && stay.kind === 'stay' ? status.label : describe(stay), trail };
  const here = prev ?? next!;
  const text = status ? status.label : prev ? `À ${placeName(prev)}` : `Avant : ${describe(next!)}`;
  return { lat: here.lat, lon: here.lon, kind: status?.kind === 'reign' ? 'reign' : 'wait', text, trail: trail.length ? trail : [[here.lat, here.lon]] };
}

function placeName(s: JourneyStop): string {
  return s.kind === 'birth' || s.kind === 'death' || s.kind === 'stay' ? s.label : s.label.replace(/^(bataille|siège) d(e |')/i, '');
}

/** An army at `t`: gathering before its first battle, marching between them, fighting at them. */
export function armyAt(army: Army, t: number, tol: number): Presence | null {
  const b = army.battles;
  if (!b.length) return null;
  const first = b[0]!;
  const last = b[b.length - 1]!;
  if (t < first.t - Math.max(0.4, tol) || t > last.t + Math.max(0.25, tol)) return null;
  const trail = b.filter((x) => x.t <= t).map((x): [number, number] => [x.lat, x.lon]);
  const fight = b.filter((x) => Math.abs(t - x.t) <= tol).sort((x, y) => Math.abs(t - x.t) - Math.abs(t - y.t))[0];
  if (fight) {
    const who = fight.commanders.length ? ` (${fight.commanders.join(', ')})` : '';
    return { lat: fight.lat, lon: fight.lon, kind: 'battle', text: `${fight.label}${who}`, ref: fight.qid, trail: [...trail, [fight.lat, fight.lon]] };
  }
  if (t < first.t) return { lat: first.lat, lon: first.lon, kind: 'wait', text: `Rassemblement avant ${first.label}`, trail: [[first.lat, first.lon]] };
  if (t > last.t) return { lat: last.lat, lon: last.lon, kind: 'wait', text: `Après ${last.label}`, trail };
  const i = b.findIndex((x) => x.t > t);
  const prev = b[i - 1]!;
  const next = b[i]!;
  const a: [number, number] = [prev.lat, prev.lon];
  const z: [number, number] = [next.lat, next.lon];
  const travel = Math.min(next.t - prev.t, Math.max(0.03, km(a, z) / ARMY_KM_PER_YEAR));
  if (t < next.t - travel) return { lat: prev.lat, lon: prev.lon, kind: 'wait', text: `Campement après ${prev.label}`, trail };
  const [lat, lon] = along(a, z, (t - (next.t - travel)) / travel);
  return { lat, lon, kind: 'travel', text: `En marche vers ${next.label}`, trail: [...trail, [lat, lon]] };
}
