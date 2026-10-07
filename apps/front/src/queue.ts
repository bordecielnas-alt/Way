import type { ScenarioWalk, WalkStep } from '@way/shared';

// The file, as a music player's queue: what was seen, the step now, what
// comes next. A scenario fills what comes next; a crochet slips a few steps
// in at its head, and the file goes on by itself after them; another route
// replaces what comes next, which is set aside (a route not taken) and may be
// taken up again. A place added from its card goes right after the step now.
// Pure: every change returns a new queue (kept in this browser by the player).

/** A step of the file: a step of one of its walks. */
export interface QueueItem {
  /** Unique within the file. */
  key: string;
  walk: string;
  step: number;
  /** Slipped in as a crochet: the crochet's walk, which groups its steps. */
  crochet?: string;
  /** Added by the visitor from a card. */
  added?: boolean;
}

/** What came next, set aside when another route was taken. */
export interface Shelf {
  /** The walk it went on with. */
  title: string;
  /** The step it was set aside at. */
  from: string;
  items: QueueItem[];
}

export interface Queue {
  walks: Record<string, ScenarioWalk>;
  items: QueueItem[];
  /** The step now (played or paused); -1 with none. */
  at: number;
  shelf: Shelf[];
  /** The next key. */
  seq: number;
}

/** Steps seen kept behind the step now, and routes not taken kept aside. */
const HISTORY_MAX = 60;
const SHELF_MAX = 5;

export const emptyQueue = (): Queue => ({ walks: {}, items: [], at: -1, shelf: [], seq: 0 });

/** The step of an item, with its walk. */
export function stepOf(q: Queue, i: number): { item: QueueItem; walk: ScenarioWalk; step: WalkStep } | null {
  const item = q.items[i];
  const walk = item && q.walks[item.walk];
  const step = item && walk?.steps[item.step];
  return item && walk && step ? { item, walk, step } : null;
}

/** The items of a walk's steps, from one on. */
function itemsOf(q: Queue, walk: ScenarioWalk, from: number, extra: Partial<QueueItem> = {}): { q: Queue; items: QueueItem[] } {
  let seq = q.seq;
  const items = walk.steps.slice(from).map((_, k) => ({ key: `i${seq++}`, walk: walk.id, step: from + k, ...extra }));
  return { q: { ...q, seq, walks: { ...q.walks, [walk.id]: walk } }, items };
}

/** What comes next set aside, if anything does: a route not taken. */
function shelve(q: Queue): Queue {
  const next = q.items.slice(q.at + 1);
  const now = stepOf(q, q.at);
  if (!next.length || !now) return q;
  const title = q.walks[next.find((x) => !x.crochet)?.walk ?? next[0]!.walk]?.title ?? '';
  const shelf = [{ title, from: now.step.place, items: next }, ...q.shelf.filter((s) => s.title !== title)].slice(0, SHELF_MAX);
  return { ...q, items: q.items.slice(0, q.at + 1), shelf };
}

/** Walks no item points to any more are forgotten; the oldest steps seen too. */
function prune(q: Queue): Queue {
  const cut = Math.max(0, q.at - HISTORY_MAX);
  const items = cut ? q.items.slice(cut) : q.items;
  const at = q.at - cut;
  const used = new Set([...items, ...q.shelf.flatMap((s) => s.items)].map((x) => x.walk));
  const walks = Object.fromEntries(Object.entries(q.walks).filter(([id]) => used.has(id)));
  return { ...q, items, at, walks };
}

/**
 * A walk taken (a scenario, another route): what came next is set aside,
 * the walk's steps come next, from `from` on; `go`: the first of them now.
 * The walk played already is only gone to.
 */
export function start(q: Queue, walk: ScenarioWalk, from = 0, go = true): Queue {
  if (!walk.steps[from]) return q;
  const here = stepOf(q, q.at);
  if (here?.walk.id === walk.id) {
    if (here.item.step === from) return q;
    const i = q.items.findIndex((x, k) => k > q.at && x.walk === walk.id && x.step === from);
    if (i >= 0) return { ...q, at: i };
  }
  const s = shelve(q);
  const { q: r, items } = itemsOf(s, walk, from);
  const first = s.at + 1;
  return prune({ ...r, items: [...s.items, ...items], at: go || s.at < 0 ? first : s.at });
}

/** A crochet: its steps slipped in right after the step now; `go`: the first of them now. */
export function crochet(q: Queue, walk: ScenarioWalk, go = true): Queue {
  if (!walk.steps.length) return q;
  if (q.at < 0) return start(q, walk);
  const { q: r, items } = itemsOf(q, walk, 0, { crochet: walk.id });
  const at = q.at + 1;
  return { ...r, items: [...q.items.slice(0, at), ...items, ...q.items.slice(at)], at: go ? at : q.at };
}

/** A place added from its card (a walk of one step): right after the step now, or the file itself when empty. */
export function add(q: Queue, walk: ScenarioWalk): Queue {
  if (q.at < 0) return start(q, walk);
  const { q: r, items } = itemsOf(q, walk, 0, { added: true });
  const at = q.at + 1;
  return { ...r, items: [...q.items.slice(0, at), ...items, ...q.items.slice(at)] };
}

/** A route set aside taken up again: what comes next now is set aside in turn. */
export function takeShelf(q: Queue, k: number): Queue {
  const taken = q.shelf[k];
  if (!taken) return q;
  const s = shelve({ ...q, shelf: q.shelf.filter((_, j) => j !== k) });
  return { ...s, items: [...s.items, ...taken.items], at: s.at + 1 };
}

export function goTo(q: Queue, i: number): Queue {
  return q.items[i] ? { ...q, at: i } : q;
}

/** An item taken out of what comes next (with its whole crochet, when it opens one); the step now stays. */
export function remove(q: Queue, key: string): Queue {
  const i = q.items.findIndex((x) => x.key === key);
  if (i <= q.at) return q;
  const item = q.items[i]!;
  const group = item.crochet && q.items.findIndex((x) => x.crochet === item.crochet) === i ? item.crochet : null;
  return prune({ ...q, items: q.items.filter((x, k) => k <= q.at || (group ? x.crochet !== group : x.key !== key)) });
}

/** An item of what comes next moved up or down by one. */
export function move(q: Queue, key: string, by: -1 | 1): Queue {
  const i = q.items.findIndex((x) => x.key === key);
  const j = i + by;
  if (i <= q.at || j <= q.at || j >= q.items.length) return q;
  const items = [...q.items];
  [items[i], items[j]] = [items[j]!, items[i]!];
  return { ...q, items };
}

/** Nothing more next. */
export function clearNext(q: Queue): Queue {
  return prune({ ...q, items: q.items.slice(0, q.at + 1) });
}

/** A walk's step changed (its text written, a turn chosen): every item of it sees the new one. */
export function updateStep(q: Queue, walkId: string, j: number, step: WalkStep): Queue {
  const w = q.walks[walkId];
  if (!w?.steps[j]) return q;
  const steps = [...w.steps];
  steps[j] = step;
  return { ...q, walks: { ...q.walks, [walkId]: { ...w, steps } } };
}

/** A stretch of the file read in one walk: its items from `from` to `to` (excluded). */
export interface Run {
  walk: string;
  from: number;
  to: number;
  /** A crochet's steps, which come back to the file after them. */
  crochet: boolean;
}

/** The file cut into its scenarios, in order: each time the walk read changes, another one starts. */
export function runsOf(q: Queue): Run[] {
  const out: Run[] = [];
  q.items.forEach((it, i) => {
    const last = out.at(-1);
    if (last && last.walk === it.walk && last.to === i) last.to = i + 1;
    else out.push({ walk: it.walk, from: i, to: i + 1, crochet: !!it.crochet });
  });
  return out;
}

/**
 * The scenarios nearest the step now, at most `max` walks: the one read,
 * then those just before and after it, by turns (the earlier first).
 */
export function nearWalks(q: Queue, max: number): Set<string> {
  const runs = runsOf(q);
  const r = runs.findIndex((x) => x.from <= q.at && q.at < x.to);
  const out = new Set<string>();
  if (r < 0) return out;
  for (let d = 0; out.size < max && (r - d >= 0 || r + d < runs.length); d++) {
    for (const k of d ? [r - d, r + d] : [r]) if (runs[k] && out.size < max) out.add(runs[k].walk);
  }
  return out;
}

/** The items of the scenario read now and of the one before it, for the player: [from, to). */
export function nearSpan(q: Queue): { from: number; to: number } {
  const runs = runsOf(q);
  const r = runs.findIndex((x) => x.from <= q.at && q.at < x.to);
  if (r < 0) return { from: 0, to: q.items.length };
  return { from: runs[Math.max(0, r - 1)]!.from, to: runs[r]!.to };
}

/** A scenario on the tree's trunk: its crochets and the routes set aside from it hang off it. */
export interface Stem {
  run: Run;
  /** Another walk than the stem before: a route taken there (else the file takes up again). */
  turn: boolean;
  crochets: Run[];
  /** Routes set aside where this stem passed (indexes in the shelf). */
  shelves: number[];
}

/**
 * The scenarios taken, as a tree: the trunk is the file's walks in order,
 * a crochet branches off the scenario before it and comes back, a route not
 * taken hangs off the last scenario that passed where it was set aside.
 */
export function treeOf(q: Queue): Stem[] {
  const stems: Stem[] = [];
  for (const r of runsOf(q)) {
    const last = stems.at(-1);
    if (r.crochet && last) last.crochets.push(r);
    else stems.push({ run: r, turn: !!last && last.run.walk !== r.walk, crochets: [], shelves: [] });
  }
  const passes = (st: Stem, place: string) =>
    [st.run, ...st.crochets].some((r) => q.items.slice(r.from, r.to).some((_, k) => stepOf(q, r.from + k)?.step.place === place));
  q.shelf.forEach((sh, k) => {
    let at = stems.length - 1;
    while (at > 0 && !passes(stems[at]!, sh.from)) at--;
    stems[at]?.shelves.push(k);
  });
  return stems;
}

/** Where the visitor is in a walk: the furthest of its steps reached, and whether all were. */
export function progressOf(q: Queue, walkId: string): { step: number; done: boolean } | undefined {
  const w = q.walks[walkId];
  const reached = q.items.slice(0, q.at + 1).filter((x) => x.walk === walkId).map((x) => x.step);
  if (!w || !reached.length) return undefined;
  const step = Math.max(...reached);
  return { step, done: step >= w.steps.length - 1 };
}

/** The file read back from storage, or empty when it does not hold together. */
export function parseQueue(raw: unknown): Queue {
  const q = raw as Queue;
  if (!q || typeof q !== 'object' || !Array.isArray(q.items) || typeof q.walks !== 'object' || !q.walks) return emptyQueue();
  const items = q.items.filter((x) => x && typeof x.key === 'string' && q.walks[x.walk]?.steps?.[x.step]);
  const shelf = (Array.isArray(q.shelf) ? q.shelf : []).map((s) => ({ ...s, items: (s.items ?? []).filter((x) => q.walks[x.walk]?.steps?.[x.step]) }))
    .filter((s) => s.items.length);
  const at = Math.min(items.length - 1, Math.max(items.length ? 0 : -1, Number(q.at) || 0));
  const keys = [...items, ...shelf.flatMap((s) => s.items)].map((x) => Number(x.key.slice(1)) || 0);
  return prune({ walks: q.walks, items, at, shelf, seq: Math.max(Number(q.seq) || 0, ...keys) + 1 });
}
