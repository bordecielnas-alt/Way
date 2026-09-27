import { existsSync, readFileSync } from 'node:fs';
import type { BorderFeature, BordersIndex, BordersPeriod } from '@way/shared';

// Yearly borders from Cliopatria (Seshat Global History Databank, CC BY 4.0),
// prepared by scripts/build-cliopatria.ts. Each polygon has its years of
// validity; composite realms ("(Kingdom of France)") list their members
// (the royal domain, Brittany, Flanders…), which become the regions shown
// when a realm is split.

interface Raw {
  n: string; f: number; t: number; q: string | null;
  /** p: polity, c: composite realm, r: relation (allegiance, tribute): not a realm. */
  k: 'p' | 'c' | 'r';
  m: string[]; a: number; g: number[][][];
}
interface RawFile { built: string; quantum: number; features: Raw[] }

const PERIOD_CACHE = 48;

export class Cliopatria {
  private data: RawFile | null = null;
  /** Years where the set of polygons changes (sorted). */
  private events: number[] = [];
  private periods = new Map<number, BordersPeriod>();
  /** Names used by each Wikidata item across the dataset (Song, Northern Song…). */
  private namesByQid = new Map<string, Set<string>>();

  constructor(private file: string) {}

  get available(): boolean {
    return this.load() !== null;
  }

  private load(): RawFile | null {
    if (this.data) return this.data;
    if (!existsSync(this.file)) return null;
    this.data = JSON.parse(readFileSync(this.file, 'utf8')) as RawFile;
    const ev = new Set<number>();
    for (const f of this.data.features) {
      ev.add(f.f);
      ev.add(f.t + 1);
      if (f.q) {
        const s = this.namesByQid.get(f.q) ?? new Set<string>();
        s.add(bare(f.n));
        this.namesByQid.set(f.q, s);
      }
    }
    this.events = [...ev].sort((a, b) => a - b);
    return this.data;
  }

  index(): BordersIndex | null {
    const d = this.load();
    if (!d) return null;
    return { version: d.built, quantum: d.quantum, events: this.events };
  }

  /** First and last years of the period that contains `year` (borders constant within). */
  periodOf(year: number): { from: number; to: number } | null {
    if (!this.load() || !this.events.length || year < this.events[0]!) return null;
    let lo = 0, hi = this.events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.events[mid]! <= year) lo = mid;
      else hi = mid - 1;
    }
    const from = this.events[lo]!;
    const next = this.events[lo + 1];
    if (next === undefined) return null; // after the dataset's end
    return { from, to: next - 1 };
  }

  /** Realms and their members valid during the period containing `year`, as a tree. */
  period(year: number): BordersPeriod | null {
    const span = this.periodOf(year);
    const d = this.data;
    if (!span || !d) return null;
    const hit = this.periods.get(span.from);
    if (hit) return hit;

    const valid = d.features
      .map((f, id) => ({ f, id }))
      .filter(({ f }) => f.k !== 'r' && f.f <= span.from && f.t >= span.from);
    // A member's parent is the smallest valid composite it names (Franks inside the Merovingian realm).
    const composites = new Map<string, { f: Raw; id: number }[]>();
    for (const v of valid) if (v.f.k === 'c') composites.set(v.f.n, [...(composites.get(v.f.n) ?? []), v]);
    const features: BorderFeature[] = valid.map(({ f, id }) => {
      const parents = f.m.flatMap((name) => composites.get(name) ?? []).filter((p) => p.id !== id);
      parents.sort((a, b) => a.f.a - b.f.a);
      return {
        id,
        name: bare(f.n),
        qid: f.q,
        composite: f.k === 'c',
        parent: parents[0]?.id ?? null,
        area: f.a,
        g: f.g,
      };
    });
    const out: BordersPeriod = { from: span.from, to: span.to, version: d.built, features };
    this.periods.set(span.from, out);
    if (this.periods.size > PERIOD_CACHE) this.periods.delete(this.periods.keys().next().value!);
    return out;
  }

  /**
   * Whether an item's French label fits this era's name: an item used under
   * several names (Song, Northern Song) keeps the era's own name, unless the
   * French label is a translation of it.
   */
  ambiguous(qid: string): boolean {
    this.load();
    return (this.namesByQid.get(qid)?.size ?? 0) > 1;
  }

  /** Wikidata items of the realms shown at a year. */
  qidsAt(year: number): string[] {
    const p = this.period(year);
    return p ? [...new Set(p.features.map((f) => f.qid).filter((q): q is string => !!q))] : [];
  }
}

/** "(Kingdom of France)" is the composite realm named after its core. */
const bare = (name: string) => name.replace(/^\((.*)\)$/, '$1').trim();
