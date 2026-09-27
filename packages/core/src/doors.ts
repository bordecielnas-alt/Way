import {
  bucketStep, distanceKm, DOOR_KINDS, formatDistance, formatYears, histToAstro, MAX_YEAR, MIN_YEAR, toLite,
  CATEGORY_LABELS, type Door, type DoorKind, type DoorsResponse, type Poi,
} from '@way/shared';
import { wikidata, type DatedRow, type RelatedRow } from '@way/providers';
import { buildPois } from './pipeline.ts';
import type { Store, StoredDoors } from './store/types.ts';

// Doors (brief §4.5), built from Wikidata relations only (no AI):
//  - time:      same place, another era (nearby entities, later if possible);
//  - meanwhile: same era, far away;
//  - next:      what came next (next part of the same war, consequence,
//               same protagonist...), or what came before as a fallback;
//  - surprise:  a lesser-known place nearby, of another kind.

/** Bump when the choice logic changes: cached doors are recomputed. */
const DOORS_VERSION = 5;
/** "Here" means close: dense cities hold hundreds of dated entities within a few km. */
const HERE_KM = 8;
/** Wider "here" for empty surroundings (a naval battle, a remote site). */
const HERE_WIDE_KM = 40;
const HERE_MIN_ROWS = 10;
/** Minimum distance for "meanwhile". */
const ELSEWHERE_KM = 1500;
/** Candidates materialized per door, in case some lack a Wikipedia article. */
const CANDIDATES = 4;

type Candidate = { row: DatedRow; title: (poi: Poi) => string; hint: (poi: Poi) => string };

/**
 * Nearby entities include roads, stations and municipalities created by
 * modern administrative reforms: poor destinations for "here" and "surprise".
 */
export function isDull(p: Pick<Poi, 'category' | 'date_start'>): boolean {
  return p.category === 'place' || (p.date_start >= 1900 && ['trade', 'polity', 'city'].includes(p.category));
}

const astroDiff = (a: number, b: number) => histToAstro(b) - histToAstro(a);

/** Stable pseudo-random order (same POI, same doors). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const REL_HINTS: Record<RelatedRow['rel'], (via: string | null) => string> = {
  next: () => 'Événement suivant',
  effect: () => 'Conséquence',
  cause: () => 'Ce qui l’a provoqué',
  prev: () => 'Événement précédent',
  partof: () => 'Ensemble plus vaste',
  part: () => 'Un épisode',
  event: () => 'Événement lié',
  person: (via) => (via ? `Même protagoniste : ${via}` : 'Même protagoniste'),
  sibling: (via) => (via ? `${via.charAt(0).toUpperCase()}${via.slice(1)}` : 'Même ensemble'),
};

// ---------- candidate selection (pure, testable) ----------

export function nextCandidates(poi: Poi, rows: RelatedRow[]): Candidate[] {
  const start = poi.date_start;
  const end = poi.date_end ?? start;
  const self = poi.wikidata_qid;
  const after = (r: DatedRow) => r.year >= end && r.year !== start;
  // Explicit sequel or consequence first, then later parts of the same whole
  // or events with the same protagonist, closest in time first.
  const score = (r: RelatedRow) => {
    const explicit = r.rel === 'next' || r.rel === 'effect';
    const later = after(r) && (r.rel === 'sibling' || r.rel === 'person' || r.rel === 'event' || r.rel === 'part');
    const tier = explicit ? 0 : later ? 1 : r.rel === 'partof' ? 2 : 3;
    const gap = Math.abs(astroDiff(end, r.year));
    return tier * 1e6 + gap * 10 - Math.log1p(r.sitelinks);
  };
  return rows
    .filter((r) => r.qid !== self)
    .sort((a, b) => score(a) - score(b))
    .slice(0, CANDIDATES)
    .map((r) => ({
      row: r,
      title: () => (r.year < start ? 'Avant cela' : 'La suite'),
      hint: () => REL_HINTS[r.rel](r.via),
    }));
}

export function timeCandidates(poi: Poi, rows: DatedRow[], radiusKm = HERE_KM): Candidate[] {
  const start = poi.date_start;
  const end = poi.date_end ?? start;
  const gap = Math.max(20, 2 * bucketStep(start));
  const near = rows.filter((r) => r.qid !== poi.wikidata_qid && distanceKm(poi, r) <= radiusKm);
  const later = near.filter((r) => r.year >= end + gap);
  const pool = later.length > 0 ? later : near.filter((r) => r.year <= start - gap);
  // Fame decides, but a famous 1995 building says less about a place's past than an old one.
  const weight = (r: DatedRow) => r.sitelinks * (r.year >= 1900 ? 0.35 : 1);
  return pool
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, CANDIDATES * 2)
    .map((r) => {
      const d = astroDiff(start, r.year);
      return {
        row: r,
        title: () => `Ici, ${formatYears(d)} plus ${d > 0 ? 'tard' : 'tôt'}`,
        hint: (dest) => (distanceKm(poi, dest) < 1 ? 'Au même endroit' : formatDistance(poi, dest)),
      };
    });
}

export function surpriseCandidates(poi: Poi, rows: DatedRow[], exclude: Set<string>): Candidate[] {
  // Lesser-known neighbors make better surprises than the obvious landmarks.
  const pool = rows.filter(
    (r) => r.qid !== poi.wikidata_qid && !exclude.has(r.qid) && r.sitelinks >= 2 && r.sitelinks <= 40,
  );
  return pool
    .sort((a, b) => hash(poi.id + a.qid) - hash(poi.id + b.qid))
    .slice(0, CANDIDATES * 2)
    .map((r) => ({
      row: r,
      title: () => 'Surprise',
      hint: (dest) => `${CATEGORY_LABELS[dest.category]} · ${formatDistance(poi, dest)}`,
    }));
}

/** Years an event lasts (0 for a dated point). */
export function spanYears(p: Pick<Poi, 'date_start' | 'date_end'>): number {
  return p.date_end === null ? 0 : astroDiff(p.date_start, p.date_end);
}

/** Window around a POI's start for "meanwhile": wider in antiquity, where dates are coarser. */
export function meanwhileRange(poi: Poi): [number, number] {
  const span = Math.max(1, Math.round(bucketStep(poi.date_start) / 2));
  return [Math.max(MIN_YEAR, poi.date_start - span), Math.min(MAX_YEAR, poi.date_start + span)];
}

// ---------- service ----------

/** Destinations already taken by other doors of the same card. */
interface Taken { ids: Set<string>; qids: Set<string> }

interface Progress {
  doors: Map<DoorKind, Door | null>;
  done: Promise<void>;
}

/**
 * Computes, caches and serves doors. Kinds are searched in parallel and served
 * as they arrive; the full set is stored on the POI once every kind is known.
 */
export class DoorService {
  private inflight = new Map<string, Progress>();

  /** `maxSpan`: "meanwhile" ignores events lasting longer (a century-long war says little about a moment). */
  constructor(private store: Store, private maxSpan: () => number = () => 20) {}

  async get(id: string): Promise<DoorsResponse | null> {
    const cached = await this.store.getDoors(id);
    // Doors chosen under another span limit are chosen again.
    if (cached && cached.v === DOORS_VERSION && (cached.span ?? 20) === this.maxSpan()) {
      const doors = await this.resolveStored(cached);
      if (doors) return { doors, pending: [] };
    }
    let p = this.inflight.get(id);
    if (!p) {
      const poi = await this.store.getPoi(id);
      if (!poi) return null;
      p = this.start(poi);
    }
    const doors = DOOR_KINDS.map((k) => p.doors.get(k)).filter((d): d is Door => !!d);
    const pending = DOOR_KINDS.filter((k) => !p.doors.has(k));
    return { doors, pending };
  }

  /** Starts computing doors in the background (card opened: doors are prefetched while reading). */
  warm(poi: Poi): void {
    if (this.inflight.has(poi.id)) return;
    void this.store.getDoors(poi.id).then((c) => {
      const stale = !c || c.v !== DOORS_VERSION || (c.span ?? 20) !== this.maxSpan();
      if (stale && !this.inflight.has(poi.id)) this.start(poi);
    });
  }

  private async resolveStored(s: StoredDoors): Promise<Door[] | null> {
    const doors: Door[] = [];
    for (const d of s.doors) {
      const poi = await this.store.getPoi(d.poi_id);
      if (!poi) return null; // destination evicted: recompute
      doors.push({ kind: d.kind, title: d.title, hint: d.hint, poi: toLite(poi) });
    }
    return doors;
  }

  private start(poi: Poi): Progress {
    const doors = new Map<DoorKind, Door | null>();
    const taken: Taken = { ids: new Set([poi.id]), qids: new Set() };
    let failed = false;

    const settle = async (kind: DoorKind, work: () => Promise<Door | null>) => {
      try {
        doors.set(kind, await work());
      } catch (e) {
        failed = true;
        doors.set(kind, null);
        console.warn(`[doors] ${kind} failed for ${poi.title}:`, (e as Error).message);
      }
    };

    const nearby = (async () => {
      const around = (km: number) => wikidata.queryAround(poi.lat, poi.lon, km, MIN_YEAR, MAX_YEAR + 1, 400);
      const rows = await around(HERE_KM);
      return rows.length >= HERE_MIN_ROWS ? { rows, km: HERE_KM } : { rows: await around(HERE_WIDE_KM), km: HERE_WIDE_KM };
    })();
    const timeDone = settle('time', async () => {
      const { rows, km } = await nearby;
      return this.pick('time', timeCandidates(poi, rows, km), taken, { accept: (d) => !isDull(d) });
    });

    const done = Promise.all([
      settle('next', async () =>
        poi.wikidata_qid ? this.pick('next', nextCandidates(poi, await wikidata.queryRelated(poi.wikidata_qid)), taken) : null,
      ),
      timeDone,
      settle('meanwhile', () => this.meanwhile(poi, taken)),
      // After "time", so both doors never lead to the same place.
      settle('surprise', async () => {
        const { rows } = await nearby;
        await timeDone;
        return this.pick('surprise', surpriseCandidates(poi, rows, taken.qids), taken, {
          // A namesake (the other battle of Thermopylae) is a "time" door, not a surprise.
          accept: (d) => d.title !== poi.title && !isDull(d),
          prefer: (d) => d.category !== poi.category,
        });
      }),
    ]).then(async () => {
      this.inflight.delete(poi.id);
      if (failed) return; // try again next time rather than caching a gap
      const stored: StoredDoors = {
        v: DOORS_VERSION,
        span: this.maxSpan(),
        doors: DOOR_KINDS.flatMap((k) => {
          const d = doors.get(k);
          return d ? [{ kind: k, title: d.title, hint: d.hint, poi_id: d.poi.id }] : [];
        }),
        empty: DOOR_KINDS.filter((k) => !doors.get(k)),
      };
      await this.store.setDoors(poi.id, stored);
    });

    const progress = { doors, done };
    this.inflight.set(poi.id, progress);
    return progress;
  }

  /** Materializes candidates as POIs and returns the first usable one as a door. */
  private async pick(
    kind: DoorKind, cands: Candidate[], taken: Taken,
    { accept, prefer }: { accept?: (p: Poi) => boolean; prefer?: (p: Poi) => boolean } = {},
  ): Promise<Door | null> {
    if (cands.length === 0) return null;
    const rows = cands.map((c) => c.row);
    await this.store.upsertPois(await buildPois(rows, this.store));
    const byQid = new Map((await this.store.getPoisByQids(rows.map((r) => r.qid))).map((p) => [p.wikidata_qid, p]));
    const usable = cands
      .map((c) => ({ c, dest: byQid.get(c.row.qid) }))
      .filter((x): x is { c: Candidate; dest: Poi } => !!x.dest && !taken.ids.has(x.dest.id) && (!accept || accept(x.dest)));
    const chosen = (prefer && usable.find((x) => prefer(x.dest))) || usable[0];
    if (!chosen) return null;
    taken.ids.add(chosen.dest.id);
    taken.qids.add(chosen.c.row.qid);
    return { kind, title: chosen.c.title(chosen.dest), hint: chosen.c.hint(chosen.dest), poi: toLite(chosen.dest) };
  }

  private async meanwhile(poi: Poi, taken: Taken): Promise<Door | null> {
    const [t0, t1] = meanwhileRange(poi);
    const far = (p: { lat: number; lon: number }) => distanceKm(poi, p) >= ELSEWHERE_KM;
    const maxSpan = this.maxSpan();
    const brief = (p: Pick<Poi, 'date_start' | 'date_end'>) => spanYears(p) <= maxSpan;
    // The cache usually knows the era already (global searches fill it).
    const known = (await this.store.queryTimeRange(t0, t1, 300))
      .filter((p) => far(p) && brief(p) && !taken.ids.has(p.id))
      .slice(0, 12);
    if (known.length > 0) {
      const dest = known[hash(poi.id) % known.length]!;
      taken.ids.add(dest.id);
      return { kind: 'meanwhile', title: 'Pendant ce temps', hint: formatDistance(poi, dest), poi: dest };
    }
    // Spans are only known once materialized: take more candidates than needed.
    const rows = (await wikidata.queryGlobal(t0, t1 + 1, 10, 150))
      .filter(far)
      .slice(0, 24)
      .sort((a, b) => hash(poi.id + a.qid) - hash(poi.id + b.qid));
    const cands = rows.slice(0, CANDIDATES * 2).map((row) => ({
      row,
      title: () => 'Pendant ce temps',
      hint: (dest: Poi) => formatDistance(poi, dest),
    }));
    return this.pick('meanwhile', cands, taken, { accept: brief });
  }
}
