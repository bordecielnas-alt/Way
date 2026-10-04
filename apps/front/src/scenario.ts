import {
  forkWalk, formatWhen, formatYear, type Door, type PoiLite, type ScenarioWalk, type Source, type StepChoice, type StepPicture, type StepQuote, type StoryPerson,
  type WalkLead,
} from '@way/shared';
import type { Entity } from './entity.ts';
import { viaServer } from './media.ts';
import type { RouteOption } from './storymap.ts';

// The carnet de route, as a column beside the map: the step played, told
// like a short illustrated article from Wikipedia (its place's picture, its
// heading, its paragraphs and the section's pictures, who was there, its
// sources and the AI that wrote it), and pinned under it the crossroads,
// "Où aller ensuite ?": go on along the planned route,
// turn away at one of its turning points, or take a short detour and come
// back. The same crossroads is drawn on the globe from the step. Tabs give
// the tree of the paths taken and not taken from this story, and the card of
// the step's place. A step's text is written when the visitor gets there,
// knowing the turns taken. Paused, the column folds to a bar.
// Every scenario started is a path, kept in "Mes chemins" with its progress.
// Paths branch: a turning point or someone's whole life is a branch of the
// path played, a detour a few steps that come back; a breadcrumb climbs
// back up. At the end of a path, ways on: a person, what it led to, another
// path through the same place, or back to the trunk. Quitting does not
// fly the map back: a bar offers to.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A path's place in the tree: started on its own, a short detour, or a whole path opened from another. */
export type PathKind = 'trunk' | 'detour' | 'branch';

export interface Path {
  walk: ScenarioWalk;
  /** Where the visitor is in it. */
  step: number;
  /** The furthest step reached. */
  seen: number;
  done: boolean;
  kind: PathKind;
  /** The path it branched off, at which step. */
  parent: { id: string; step: number } | null;
  /** Last played. */
  at: number;
}

/** A crossroads: someone present at the step, or its place. */
export type Lead = { kind: 'person'; person: StoryPerson; hero?: boolean } | { kind: 'place'; poi: PoiLite };

/** Where a crossroads is taken: the step's year and the path branched off. */
export interface LeadFrom {
  year: number;
  walk: ScenarioWalk | null;
}

/** Paths through a place or a person, shown in the carnet ("Chemins qui passent par…"). */
export interface Here {
  /** The card's id or the person's item. */
  key: string;
  title: string;
  walks: ScenarioWalk[];
  /** `pending` while an AI writes them. */
  status: 'ready' | 'pending' | 'none' | 'no-ai';
  person?: StoryPerson;
  poi?: PoiLite;
}

const KIND_LABELS: Record<PathKind, string> = { trunk: 'Chemin', detour: 'Détour', branch: 'Branche' };
const KIND_ICONS: Record<PathKind, string> = { trunk: '●', detour: '↩', branch: '⑂' };
/** Paths remembered in this browser. */
const PATHS_KEY = 'orbis:paths';
const PATHS_MAX = 60;
/** Two steps closer than this pass through the same place. */
const SAME_PLACE_KM = 40;
const MAX_FORKS = 3;
const MAX_DECISIONS = 6;

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** The crossroads of a step: the people present (not the protagonist), the protagonist's own life, the place's card. Pure, for tests. */
export function stepLeads(walk: ScenarioWalk, j: number): Lead[] {
  const st = walk.steps[j];
  if (!st) return [];
  const people: Lead[] = st.cast.filter((p) => p.qid !== walk.hero?.qid).slice(0, 2).map((person) => ({ kind: 'person', person }));
  // A card's scenario follows its hero through one story: their whole life is a path of its own.
  if (walk.hero && walk.from && people.length < 2) people.push({ kind: 'person', person: walk.hero, hero: true });
  const place: Lead[] = st.poi && st.poi.id !== walk.from?.id ? [{ kind: 'place', poi: st.poi }] : [];
  return [...people.slice(0, MAX_FORKS - place.length), ...place];
}

/** Paths known that pass through a step's place (not the walk itself). Pure, for tests. */
export function throughPlace(walks: ScenarioWalk[], walk: ScenarioWalk, j: number, limit = 2): ScenarioWalk[] {
  const st = walk.steps[j];
  if (!st) return [];
  return walks
    .filter((w) => w.id !== walk.id && w.steps.some((s) => (st.poi && s.poi?.id === st.poi.id) || km(s, st) < SAME_PLACE_KM))
    .slice(0, limit);
}

/** Where a step may lead, as drawn on the globe: the way on, the turning points, the detours to a place. Pure, for tests. */
export function routeOptions(walk: ScenarioWalk, j: number): RouteOption[] {
  const st = walk.steps[j];
  if (!st) return [];
  const out: RouteOption[] = [];
  const next = walk.steps[j + 1];
  if (next) out.push({ key: 'next', kind: 'next', label: next.place, lat: next.lat, lon: next.lon });
  (st.forks ?? []).forEach((f, k) => {
    const to = f.steps[0];
    if (to) out.push({ key: `fork:${k}`, kind: 'fork', label: f.label, lat: to.lat, lon: to.lon });
  });
  (st.choices ?? []).forEach((c, k) => {
    const to = c.step ?? c.poi;
    if (to) out.push({ key: `choice:${k}`, kind: 'detour', label: c.step?.place ?? c.poi!.title, lat: to.lat, lon: to.lon });
  });
  return out;
}

/** The turns taken before a step, oldest first: before the walk (a turning point's), then along it. Pure, for tests. */
export function stepDecisions(walk: ScenarioWalk, j: number): string[] {
  const along = walk.steps.slice(0, j).flatMap((s) => (s.chosen !== undefined && s.choices?.[s.chosen] ? [s.choices[s.chosen]!.label] : []));
  return [...(walk.decisions ?? []), ...along].slice(-MAX_DECISIONS);
}

/** The paths remembered: progress and branches, kept in this browser. */
class Journal {
  private paths = new Map<string, Path>();

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(PATHS_KEY) ?? '[]') as Path[];
      if (Array.isArray(raw)) for (const p of raw) if (p?.walk?.id && Array.isArray(p.walk.steps)) this.paths.set(p.walk.id, p);
    } catch {
      /* storage unavailable: no path remembered */
    }
  }

  get(id: string): Path | undefined {
    return this.paths.get(id);
  }

  put(p: Path): void {
    this.paths.set(p.walk.id, p);
    this.save();
  }

  remove(id: string): void {
    this.paths.delete(id);
    // Its branches hang from where it hung.
    for (const p of this.paths.values()) if (p.parent?.id === id) p.parent = null;
    this.save();
  }

  /** The latest played first. */
  list(): Path[] {
    return [...this.paths.values()].sort((a, b) => b.at - a.at);
  }

  /** The paths hanging from one, by the step they leave. */
  children(id: string): Path[] {
    return this.list().filter((p) => p.parent?.id === id).sort((a, b) => a.parent!.step - b.parent!.step || a.at - b.at);
  }

  save(): void {
    const kept = this.list().slice(0, PATHS_MAX);
    this.paths = new Map(kept.map((p) => [p.walk.id, p]));
    try {
      localStorage.setItem(PATHS_KEY, JSON.stringify(kept));
    } catch {
      /* not remembered */
    }
  }
}

/** A step's text written, with the people present and the turns the story may take. */
export interface StepText {
  text: string;
  cast: StoryPerson[];
  choices: StepChoice[];
  next: string | null;
  facts: string[];
  quote: StepQuote | null;
  gallery: StepPicture[];
  near: PoiLite[];
  sources: Source[];
  ai: string | null;
}

/** A step's picture as kept: paths remembered before captions kept plain addresses. */
const pictureOf = (g: StepPicture | string): StepPicture => (typeof g === 'string' ? { src: g, caption: null } : g);

/** A step's picture for its thumbnail: its place's, else the first of its gallery. */
const thumbOf = (s: { image?: string | null; gallery?: (StepPicture | string)[] }): string | null =>
  s.image ?? (s.gallery?.[0] ? pictureOf(s.gallery[0]).src : null);

/** A picture between a step's paragraphs, with its caption, as an article shows it. */
const figure = (g: StepPicture) => `<figure class="film-fig">
    <img alt="${esc(g.caption ?? '')}" src="${esc(viaServer(g.src))}" referrerpolicy="no-referrer" loading="lazy">
    ${g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ''}
  </figure>`;

/** Elsewhere from a step: what happened meanwhile, what led there (the card's doors). */
export interface StepDoors {
  meanwhile: Door | null;
  cause: Door | null;
  effect: Door | null;
}

type Drawer = 'paths' | 'here' | 'tree' | 'suites';
/** What the column shows while a path plays: the step, the tree of its paths, the card of its place. */
export type CarnetTab = 'step' | 'tree' | 'card';

/** "de Napoléon", "d’Edward". */
const of = (name: string) => (/^[aeiouyàâéèêëîïôöùûü]/i.test(name) ? `d’${name}` : `de ${name}`);

const face = (p: { name: string; image: string | null }) =>
  `<span class="cn-fork-mark">${p.image ? `<img alt="" src="${esc(viaServer(p.image))}" referrerpolicy="no-referrer">` : esc(p.name.charAt(0))}</span>`;

export class Carnet {
  private journal = new Journal();
  private current: string | null = null;
  /** Clicked elsewhere: the path waits, its people leave the map; the column folds to a bar. */
  private paused = false;
  /** What is opened beside the column (or alone): paths, a place's or person's paths, the forest, the ways on. */
  private drawer: Drawer | null = null;
  private tab: CarnetTab = 'step';
  private here: Here | null = null;
  /** Something being prepared (a detour, a life written by an AI). */
  private note: string | null = null;
  /** The AI writing the step played, while it does. */
  private writer: string | null = null;
  /** A path just left: the bar offering to go back to where the visitor was before it. */
  private back: string | null = null;
  /** "Explorer autour" unfolded. */
  private around = false;
  /** The crossroads unfolded: its turning points and detours, not only the way on. */
  private crossOpen = false;
  /** What the buttons shown point to. */
  private leads: Lead[] = [];
  private walksShown: ScenarioWalk[] = [];
  private afterShown: WalkLead[] = [];
  /** Doors of the cards met, by card. */
  private doors = new Map<string, StepDoors | 'pending'>();

  /** A step to show: map, timeline, its card and its people go there; `first`: a path started or taken up again. */
  onStep: (walk: ScenarioWalk, step: number, first: boolean) => void = () => undefined;
  /** Where the step played may go, to draw on the globe. */
  onRoute: (walk: ScenarioWalk, step: number, options: RouteOption[]) => void = () => undefined;
  /** A step without its text: to be written (and the next one ahead). */
  onNeedText: (walk: ScenarioWalk, step: number) => void = () => undefined;
  /** Paused: the people of the step leave the map. */
  onPause: () => void = () => undefined;
  /** No path played any more: `restore`, the bar may offer to go back to where the visitor was. */
  onEnd: (restore: boolean) => void = () => undefined;
  /** Back to where the visitor was before the path, asked from the bar. */
  onReturn: () => void = () => undefined;
  /** The path played, its step or its state changed (cards mark it). */
  onChange: () => void = () => undefined;
  /** A card to open beside the film. */
  onOpenCard: (poi: PoiLite) => void = () => undefined;
  /** A crossroads taken: a short detour around the step's year, or the whole path. */
  onLead: (lead: Lead, how: 'detour' | 'full', at: LeadFrom) => void = () => undefined;
  /** A walk met: remembered for the search bar. */
  onMet: (walk: ScenarioWalk) => void = () => undefined;
  /** A card's doors (meanwhile, what led there), for a step's crossroads. */
  doorsFor: (poi: PoiLite) => Promise<StepDoors> = async () => ({ meanwhile: null, cause: null, effect: null });
  /** A name to act on (someone present at the step): its menu opens under it. */
  onEntity: (anchor: HTMLElement, e: Entity) => void = () => undefined;
  /** A tab of the column shown. */
  onTab: (tab: CarnetTab) => void = () => undefined;
  /** The title of the card beside the step, if one is open (its tab). */
  cardTitle: () => string | null = () => null;

  constructor(private root: HTMLElement, private known: () => ScenarioWalk[]) {
    root.addEventListener('click', (e) => this.click(e));
    root.addEventListener('toggle', (e) => {
      if ((e.target as Element).classList?.contains('film-around')) this.around = (e.target as HTMLDetailsElement).open;
    }, true);
    // Before the card and the timeline: while a path plays, the arrows are the film's.
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
      const playing = this.playingPath && !this.paused;
      if (e.key === 'Escape' && this.drawer) this.closeDrawer();
      else if (playing && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) this.go(e.key === 'ArrowRight' ? 1 : -1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    this.render();
  }

  private get playingPath(): Path | null {
    return (this.current && this.journal.get(this.current)) || null;
  }

  /** The path played (or paused) and its step. */
  get playing(): { walk: ScenarioWalk; step: number } | null {
    const p = this.playingPath;
    return p && { walk: p.walk, step: p.step };
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** What is known of a path (its progress), for the cards. */
  pathOf(id: string): Path | undefined {
    return this.journal.get(id);
  }

  /**
   * Plays a walk from a step. `branch`: hung on the path played (or on
   * `on`, at its step), as a detour or a branch; otherwise a path keeps its
   * place in the tree (a new one is a trunk).
   */
  play(walk: ScenarioWalk, step = 0, branch?: PathKind, on?: { id: string; step: number }): void {
    if (!walk.steps[step]) return;
    const from = on ? this.journal.get(on.id) ?? null : this.playingPath;
    const fromStep = on ? on.step : from?.step ?? 0;
    const first = this.current !== walk.id || this.paused;
    const now = Date.now();
    const known = this.journal.get(walk.id);
    const p: Path = known ?? { walk, step, seen: step, done: false, kind: 'trunk', parent: null, at: now };
    // A walk played before keeps its texts and the turns taken.
    p.walk = known && known.walk.steps.length >= walk.steps.length ? known.walk : walk;
    p.step = step;
    p.seen = Math.max(p.seen, step);
    p.at = now;
    if (branch && from && from.walk.id !== walk.id && !this.ancestors(from).some((a) => a.walk.id === walk.id)) {
      p.kind = branch;
      p.parent = { id: from.walk.id, step: fromStep };
    }
    this.journal.put(p);
    this.onMet(p.walk);
    this.current = walk.id;
    this.paused = false;
    this.drawer = null;
    this.note = null;
    this.back = null;
    if (this.tab === 'tree' && first) this.tab = 'step';
    this.show(first);
  }

  /** Clicked elsewhere on the globe: the path waits, the column folds to a bar; with none played, the drawer closes. */
  pause(): void {
    if (!this.playingPath) {
      if (this.drawer) this.closeDrawer();
      return;
    }
    if (this.paused) return;
    this.paused = true;
    this.drawer = null;
    this.onPause();
    this.render();
    this.onChange();
  }

  resume(): void {
    const p = this.playingPath;
    if (!p) return;
    this.play(p.walk, p.step);
  }

  /** Leaves the path played: back up to the one it branched off, else nothing plays (a bar offers the view of before). */
  quit(): void {
    const p = this.playingPath;
    if (!p) return this.closeDrawer();
    const parent = p.parent && this.journal.get(p.parent.id);
    if (parent) {
      this.play(parent.walk, Math.min(p.parent!.step, parent.walk.steps.length - 1));
      return;
    }
    this.current = null;
    this.paused = false;
    this.drawer = null;
    this.back = p.walk.title;
    this.onEnd(true);
    this.render();
    this.onChange();
  }

  /** Scenarios turned off: everything stops where it is. */
  stop(): void {
    this.note = null;
    this.here = null;
    this.drawer = null;
    this.back = null;
    const had = !!this.current;
    this.current = null;
    this.paused = false;
    if (had) this.onEnd(false);
    this.render();
    this.onChange();
  }

  /** The paths through a place or a person, in the drawer. */
  showHere(here: Here): void {
    this.here = here;
    this.openDrawer('here');
  }

  /** New paths for the place or person shown (written meanwhile). */
  updateHere(here: Here): void {
    if (this.here?.key !== here.key) return;
    this.here = here;
    if (this.drawer === 'here') this.render();
  }

  get hereKey(): string | null {
    return this.here?.key ?? null;
  }

  /** A step of the path played, chosen on the map. */
  showStep(j: number): void {
    this.goto(j);
  }

  /** Where the path may go, chosen on the map (`RouteOption.key`). */
  takeOption(key: string): void {
    const p = this.playingPath;
    if (!p || this.paused) return;
    const [kind, n] = key.split(':');
    if (kind === 'next') this.go(1);
    else if (kind === 'fork') this.takeFork(p, p.step, Number(n));
    else if (kind === 'choice') this.choose(Number(n));
  }

  showPaths(): void {
    this.openDrawer('paths');
  }

  /** The card beside the step changed (its tab's title). */
  refreshCard(): void {
    if (this.playingPath && !this.paused) this.render();
  }

  /** What is being prepared ("L'IA écrit un détour…"), or null. */
  setNote(text: string | null): void {
    this.note = text;
    this.render();
  }

  /** The AI writing the step played (null once done). */
  setWriter(ai: string | null): void {
    if (ai === this.writer) return;
    this.writer = ai;
    this.render();
  }

  /** A step's text has come: kept with the path (it is not written twice). */
  setStepText(walkId: string, j: number, t: StepText): void {
    const p = this.journal.get(walkId);
    const st = p?.walk.steps[j];
    if (!p || !st) return;
    this.writer = null;
    p.walk.steps[j] = {
      ...st, text: t.text, cast: t.cast.length ? t.cast : st.cast, choices: t.choices, next: t.next, facts: t.facts, quote: t.quote, gallery: t.gallery, near: t.near,
      sources: t.sources, ai: t.ai,
    };
    this.journal.save();
    this.onMet(p.walk);
    if (this.current === walkId && p.step === j) this.render();
  }

  private openDrawer(d: Drawer): void {
    this.drawer = d;
    this.render();
  }

  private closeDrawer(): void {
    this.drawer = null;
    this.render();
  }

  private ancestors(p: Path): Path[] {
    const out: Path[] = [];
    const seen = new Set([p.walk.id]);
    let at = p.parent && this.journal.get(p.parent.id);
    while (at && !seen.has(at.walk.id)) {
      out.unshift(at);
      seen.add(at.walk.id);
      at = at.parent && this.journal.get(at.parent.id);
    }
    return out;
  }

  private go(delta: number): void {
    const p = this.playingPath;
    if (!p) return;
    this.goto(p.step + delta);
  }

  private goto(j: number): void {
    const p = this.playingPath;
    if (!p || !p.walk.steps[j]) return;
    p.step = j;
    p.seen = Math.max(p.seen, j);
    p.at = Date.now();
    this.journal.save();
    const first = this.paused;
    this.paused = false;
    if (this.drawer === 'suites') this.drawer = null;
    if (this.tab === 'card') this.tab = 'step';
    this.show(first);
  }

  /** A turning point taken (at a step of a path): its own walk, a branch hung there; taken again, where it was left. */
  private takeFork(on: Path, at: number, k: number): void {
    const w = forkWalk(on.walk, at, k);
    if (!w) return;
    const known = this.journal.get(w.id);
    this.play(known?.walk ?? w, known && !known.done ? known.step : 0, 'branch', { id: on.walk.id, step: at });
  }

  /**
   * A detour taken: a place of the story becomes the next step of the path
   * (once per step), then the route goes on; someone met, or another card,
   * opens a few steps there, hung on this step, that come back.
   */
  private choose(k: number): void {
    const p = this.playingPath;
    const st = p?.walk.steps[p.step];
    const c = st?.choices?.[k];
    if (!p || !st || !c) return;
    if (c.poi || c.person) {
      p.walk.steps[p.step] = { ...st, chosen: k };
      this.journal.save();
      this.onLead(c.person ? { kind: 'person', person: c.person } : { kind: 'place', poi: c.poi! }, 'detour', { year: st.year, walk: p.walk });
      return;
    }
    if (!c.step) return;
    const steps = [...p.walk.steps];
    const before = st.chosen !== undefined ? st.choices?.[st.chosen]?.step : undefined;
    if (before && steps[p.step + 1]?.stop === before.stop) steps.splice(p.step + 1, 1);
    steps[p.step] = { ...st, chosen: k };
    steps.splice(p.step + 1, 0, { ...c.step });
    p.walk = { ...p.walk, steps };
    this.journal.put(p);
    this.goto(p.step + 1);
  }

  private finish(): void {
    const p = this.playingPath;
    if (p) {
      p.done = true;
      this.journal.save();
    }
    this.quit();
  }

  private show(first: boolean): void {
    const p = this.playingPath!;
    // Laid out first: the map flies to the part the column leaves visible.
    this.render();
    this.onStep(p.walk, p.step, first);
    // Written by the step's writer, or still to be: those of a life come with a few lines, made a full step on arrival.
    this.writer = null;
    if (!p.walk.steps[p.step]!.ai) this.onNeedText(p.walk, p.step);
    this.onChange();
  }

  private click(e: MouseEvent): void {
    const b = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!b || !this.root.contains(b)) return;
    const p = this.playingPath;
    const n = Number(b.dataset.i);
    const walkAt = () => this.walksShown[n];
    switch (b.dataset.act) {
      case 'drawer': {
        const d = b.dataset.view as Drawer;
        return this.drawer === d ? this.closeDrawer() : this.openDrawer(d);
      }
      case 'close-drawer': return this.closeDrawer();
      case 'tab': {
        const tab = b.dataset.tab as CarnetTab;
        this.tab = this.tab === tab && tab !== 'step' ? 'step' : tab;
        this.render();
        return this.onTab(this.tab);
      }
      case 'pause': return this.pause();
      case 'resume': return this.resume();
      case 'quit': return this.quit();
      case 'prev': return this.go(-1);
      case 'next': return this.go(1);
      case 'dot': return this.goto(n);
      case 'fork':
        if (p) this.takeFork(p, p.step, n);
        return;
      case 'choice': return this.choose(n);
      case 'retry':
        if (p) this.onNeedText(p.walk, p.step);
        return;
      case 'cross':
        this.crossOpen = !this.crossOpen;
        return this.render();
      case 'finish': return this.finish();
      case 'back': return this.quit();
      case 'return':
        this.back = null;
        this.render();
        return this.onReturn();
      case 'dismiss-return':
        this.back = null;
        return this.render();
      case 'crumb': {
        const a = this.journal.get(b.dataset.id!);
        if (a) this.play(a.walk, Number(b.dataset.step));
        return;
      }
      case 'path': {
        const a = this.journal.get(b.dataset.id!);
        if (a) this.play(a.walk, a.done ? 0 : a.step);
        return;
      }
      case 'tree-step': {
        const a = this.journal.get(b.dataset.id!);
        if (!a) return;
        if (a.walk.id === this.current && !this.paused) return this.goto(Number(b.dataset.step));
        this.play(a.walk, Number(b.dataset.step));
        return;
      }
      case 'tree-fork': {
        const a = this.journal.get(b.dataset.id!);
        if (a) this.takeFork(a, Number(b.dataset.step), n);
        return;
      }
      case 'forget':
        if (b.dataset.id === this.current) return;
        this.journal.remove(b.dataset.id!);
        return this.render();
      case 'lead': {
        const lead = this.leads[n];
        if (lead && p) this.onLead(lead, b.dataset.how as 'detour' | 'full', { year: p.walk.steps[p.step]!.year, walk: p.walk });
        return;
      }
      case 'who': {
        const person = p?.walk.steps[p.step]?.cast[n];
        if (person) this.onEntity(b, { kind: 'person', person });
        return;
      }
      case 'near': {
        const st = p?.walk.steps[p.step];
        const poi = st?.near?.[n];
        if (p && st && poi) this.onLead({ kind: 'place', poi }, 'detour', { year: st.year, walk: p.walk });
        return;
      }
      case 'near-card': {
        const poi = p?.walk.steps[p.step]?.near?.[n];
        if (poi) this.onOpenCard(poi);
        return;
      }
      case 'pic': {
        const img = this.root.querySelector<HTMLImageElement>('.film-img img');
        const url = b.dataset.url;
        if (!url) return;
        if (img) img.src = url;
        else {
          const fig = this.root.querySelector('.film-img');
          fig?.classList.remove('no-img');
          fig?.insertAdjacentHTML('afterbegin', `<img alt="" src="${esc(url)}" referrerpolicy="no-referrer">`);
        }
        const caption = this.root.querySelector<HTMLElement>('.film-img-caption');
        if (caption) {
          caption.textContent = b.dataset.caption ?? '';
          caption.hidden = !b.dataset.caption;
        }
        this.root.querySelectorAll('.film-pic').forEach((x) => x.classList.toggle('on', x === b));
        this.root.querySelector('.film-pane')?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      case 'door': {
        const d = this.stepDoors(p)?.[b.dataset.kind as keyof StepDoors];
        if (d) this.onOpenCard(d.poi);
        return;
      }
      case 'walk': {
        const w = walkAt();
        if (!w) return;
        const known = this.journal.get(w.id);
        this.play(w, known && !known.done ? known.step : 0);
        return;
      }
      case 'branch': {
        const w = walkAt();
        if (w) this.play(w, 0, 'branch');
        return;
      }
      case 'after-paths': {
        const l = this.afterShown[n];
        if (l) this.onLead({ kind: 'place', poi: l.poi }, 'full', { year: l.year, walk: p?.walk ?? null });
        return;
      }
      case 'card': {
        const poi = b.dataset.after !== undefined ? this.afterShown[Number(b.dataset.after)]?.poi : this.here?.poi ?? p?.walk.from;
        if (poi) this.onOpenCard(poi);
        return;
      }
      case 'life':
        if (this.here?.person) {
          this.onLead({ kind: 'person', person: this.here.person }, b.dataset.how as 'detour' | 'full', { year: p?.walk.steps[p.step]!.year ?? 0, walk: p?.walk ?? null });
        }
        return;
    }
  }

  /** The doors of the step's card (or the walk's), asked once per card. */
  private stepDoors(p: Path | null): StepDoors | null {
    const st = p?.walk.steps[p.step];
    const poi = st?.poi ?? p?.walk.from;
    if (!poi) return null;
    const known = this.doors.get(poi.id);
    if (known === 'pending') return null;
    if (known) return known;
    this.doors.set(poi.id, 'pending');
    void this.doorsFor(poi)
      .catch(() => ({ meanwhile: null, cause: null, effect: null }))
      .then((d) => {
        this.doors.set(poi.id, d);
        const now = this.playingPath;
        if (now && !this.paused && (now.walk.steps[now.step]?.poi ?? now.walk.from)?.id === poi.id) this.render();
      });
    return null;
  }

  private render(): void {
    const p = this.playingPath;
    const playing = !!p && !this.paused;
    const tab = playing ? (this.tab === 'card' && !this.cardTitle() ? 'step' : this.tab) : 'step';
    document.body.classList.toggle('scenario-on', playing);
    document.body.classList.toggle('carnet-open', playing);
    document.body.classList.toggle('carnet-card', playing && tab === 'card');
    const note = this.note ? `<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>${esc(this.note)}</div>` : '';
    const count = this.journal.list().length;
    const drawer = this.drawer ? this.drawerView(this.drawer, p) : '';
    let bottom: string;
    if (playing) bottom = this.film(p!, note, tab);
    else if (p) bottom = this.bar(p, note);
    else if (this.back) bottom = this.backBar(note);
    else if (note) bottom = `<div class="film-bar panel">${note}</div>`;
    // Nothing played: a way back to the paths already explored.
    else bottom = count && !this.drawer ? `<button type="button" class="carnet-launch panel" data-act="drawer" data-view="paths" title="Les chemins commencés">🎭 Mes chemins <span class="cn-count">${count}</span></button>` : '';
    this.root.hidden = !drawer && !bottom;
    this.root.className = `carnet${playing ? ' playing' : ''}${this.drawer ? ' with-drawer' : ''}`;
    this.root.innerHTML = `${drawer}${bottom}`;
    this.root.querySelectorAll<HTMLImageElement>('img').forEach((img) => img.addEventListener('error', () => {
      img.closest('.film-img')?.classList.add('no-img');
      img.remove();
    }));
    this.root.querySelector('.film-thumb.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    this.root.querySelector('.tr-step.here')?.scrollIntoView({ block: 'nearest' });
    if (playing) {
      // The card's tab shows the card under the column's head.
      const film = this.root.querySelector('.film');
      if (film) document.body.style.setProperty('--carnet-top', `${Math.round(film.getBoundingClientRect().bottom + 8)}px`);
      this.onRoute(p!.walk, p!.step, routeOptions(p!.walk, p!.step));
    }
  }

  /** Paused: a bar to resume. */
  private bar(p: Path, note: string): string {
    const n = p.walk.steps.length;
    return `<div class="film-bar panel">
        <div class="sc-pill">
          <span class="sc-pill-icon" aria-hidden="true">⏸</span>
          <span class="sc-pill-text"><b>${esc(p.walk.title)}</b> · étape ${p.step + 1}/${n}</span>
          <button type="button" class="sc-btn sc-primary" data-act="resume">Reprendre ▸</button>
          <button type="button" class="sc-icon sc-quit" data-act="quit" title="Quitter ce chemin" aria-label="Quitter ce chemin">✕</button>
        </div>${note}
      </div>`;
  }

  /** A path just left: the map stays where it is; going back to the view of before is offered. */
  private backBar(note: string): string {
    return `<div class="film-bar panel">
        <div class="sc-pill">
          <span class="sc-pill-icon" aria-hidden="true">↩</span>
          <span class="sc-pill-text">Chemin quitté : <b>${esc(this.back!)}</b></span>
          <button type="button" class="sc-btn sc-primary" data-act="return" title="La carte et la frise reviennent où vous étiez avant ce chemin">Revenir où j’étais</button>
          <button type="button" class="sc-icon" data-act="dismiss-return" title="Rester ici" aria-label="Rester ici">✕</button>
        </div>${note}
      </div>`;
  }

  /** The column: its head and tabs, the step played (or the tree), the crossroads pinned under it, the reel of steps. */
  private film(p: Path, note: string, tab: CarnetTab): string {
    const w = p.walk;
    const protagonist = w.invented ? 'Fil thématique' : w.hero ? esc(w.hero.name) : 'Personnage réel';
    const family = this.familyOf(p);
    const card = this.cardTitle();
    const tabs = `<nav class="film-tabs" role="tablist" aria-label="Carnet">
        <button type="button" role="tab" class="film-tab${tab === 'step' ? ' on' : ''}" aria-selected="${tab === 'step'}" data-act="tab" data-tab="step">Étape ${p.step + 1}/${w.steps.length}</button>
        <button type="button" role="tab" class="film-tab${tab === 'tree' ? ' on' : ''}" aria-selected="${tab === 'tree'}" data-act="tab" data-tab="tree" title="Les chemins pris et non pris de cette histoire">⑂ Arbre${family > 1 ? ` <span class="cn-count">${family}</span>` : ''}</button>
        ${card ? `<button type="button" role="tab" class="film-tab film-tab-card${tab === 'card' ? ' on' : ''}" aria-selected="${tab === 'card'}" data-act="tab" data-tab="card" title="La fiche de ce lieu">Fiche · ${esc(card)}</button>` : ''}
      </nav>`;
    const body = tab === 'tree'
      ? `<div class="film-pane"><div class="cn-kicker">L’arbre de ce chemin <span class="cn-aside">· pris en plein, non pris en pointillés</span></div><ol class="tr">${this.treeSteps(this.ancestors(p)[0] ?? p, p, new Set([...this.ancestors(p), p].map((a) => a.walk.id)))}</ol></div>`
      : tab === 'step' ? `<div class="film-pane">${this.stepView(p)}</div>${note}${this.cross(p)}` : '';
    return `<section class="film panel tab-${tab}" aria-label="Chemin en cours">
        <header class="film-head">
          <span class="film-kicker"><span class="sc-live" aria-hidden="true"></span>${protagonist}${p.kind !== 'trunk' ? ` · <span class="cn-kind">${KIND_LABELS[p.kind]}</span>` : ''}</span>
          <span class="film-acts">
            <button type="button" class="sc-btn${this.drawer === 'paths' ? ' on' : ''}" data-act="drawer" data-view="paths" title="Mes chemins">🎭 <span class="cn-count">${this.journal.list().length}</span></button>
            <button type="button" class="sc-icon" data-act="pause" title="Mettre en pause" aria-label="Mettre en pause">⏸</button>
            <button type="button" class="sc-icon sc-quit" data-act="quit" title="${p.parent ? 'Quitter ce chemin et revenir à celui d’où il part' : 'Quitter ce chemin'}" aria-label="Quitter ce chemin">✕</button>
          </span>
        </header>
        <h2 class="film-title">${esc(w.title)}</h2>
        ${this.crumbs(p)}
        ${tabs}
        ${body}
        ${tab === 'card' ? '' : this.reel(p)}
      </section>`;
  }

  /**
   * The step played, as a short illustrated article: its place and moment,
   * its heading, its paragraphs with the section's pictures and their
   * captions between them, a sentence of the article, the facts to keep,
   * who was there, its sources and the AI that wrote it; around it, folded.
   */
  private stepView(p: Path): string {
    const w = p.walk;
    const st = w.steps[p.step]!;
    this.leads = stepLeads(w, p.step);
    this.walksShown = [];
    this.afterShown = [];
    const pics = (st.gallery ?? []).map(pictureOf);
    const head = st.image ? { src: st.image, caption: null } : pics.shift() ?? null;
    const paragraphs = st.text ? st.text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) : [];
    // Pictures between the paragraphs, as an article shows them (never after the last); the others in a strip.
    const slots = [0, 2].filter((k) => k < paragraphs.length - 1).slice(0, pics.length);
    const inline = pics.slice(0, slots.length);
    const strip = pics.slice(slots.length);
    const quote = st.quote
      ? `<blockquote class="film-quote">« ${esc(st.quote.text)} »<cite><a href="${esc(st.quote.source.url)}" target="_blank" rel="noopener">${esc(st.quote.source.title)}</a></cite></blockquote>`
      : '';
    const quoteAt = paragraphs.length > 2 ? 1 : paragraphs.length - 1;
    const writing = (what: string) => `<div class="film-writing"><span class="sc-note-dot" aria-hidden="true"></span>${what}
          <button type="button" class="sc-link" data-act="retry">relancer</button></div>`;
    const article = paragraphs.length
      ? `<div class="film-article">${paragraphs.map((t, k) => {
        const at = slots.indexOf(k);
        return `<p class="film-par${k === 0 ? ' film-lead' : ''}">${esc(t)}</p>${at >= 0 ? figure(inline[at]!) : ''}${k === quoteAt ? quote : ''}`;
      }).join('')}</div>
        ${!st.ai && this.writer ? writing(`${esc(this.writer)} développe cette étape d’après Wikipédia…`) : ''}`
      : `${writing(`${this.writer ? esc(this.writer) : 'L’IA'} écrit cette étape d’après l’article de Wikipédia sur ${esc(st.place)}…`)}
          <div class="film-text skeleton-lines"><i></i><i></i><i></i><i></i><i></i></div>`;
    const facts = st.facts?.length
      ? `<aside class="film-facts"><div class="film-box-title">Repères</div><ul>${st.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></aside>`
      : '';
    const who = st.text && st.cast.length
      ? `<section class="film-who"><div class="film-box-title">Présents</div><div class="film-who-list">${st.cast.map((c, k) => `<button type="button" class="film-person" data-act="who" data-i="${k}" title="${esc(`${c.name} · ${c.role}`)}" aria-haspopup="menu">
          ${face(c)}<span class="film-person-text"><b>${esc(c.name)}</b><small>${esc(c.role)}</small></span></button>`).join('')}</div></section>`
      : '';
    const pictures = strip.length
      ? `<div class="film-gallery">${strip.map((g, k) => `<button type="button" class="film-pic" data-act="pic" data-url="${esc(viaServer(g.src))}" data-caption="${esc(g.caption ?? '')}" aria-label="${esc(g.caption ?? `Image ${k + 1}`)}" title="${esc(g.caption ?? '')}"><img alt="" src="${esc(viaServer(g.src))}" referrerpolicy="no-referrer" loading="lazy"></button>`).join('')}</div>`
      : '';
    const sources = st.sources?.length ? st.sources : st.text ? [w.source] : [];
    const credit = st.ai
      ? `Texte rédigé par <b>${esc(st.ai)}</b> d’après ${sources.length > 1 ? 'ces articles' : 'cet article'} de Wikipédia (CC BY-SA) : vérifiez-les.`
      : st.text ? 'Texte écrit avec le chemin, d’après l’article ci-dessus.' : '';
    const footer = sources.length
      ? `<footer class="film-sources"><div class="film-box-title">Sources</div>
          <ul>${sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title.replace(/^Wikipédia : /, ''))}</a></li>`).join('')}</ul>
          <p class="film-ai">${credit}${w.ai ? ` Chemin tracé par ${esc(w.ai)}.` : ''}</p></footer>`
      : '';
    return `<figure class="film-img${head ? '' : ' no-img'}">
          ${head ? `<img alt="" src="${esc(viaServer(head.src))}" referrerpolicy="no-referrer">` : ''}
          <figcaption><b>${esc(st.place)}</b><span>${esc(formatWhen(st))}</span></figcaption>
        </figure>
        <p class="film-img-caption"${head?.caption ? '' : ' hidden'}>${esc(head?.caption ?? '')}</p>
        ${st.beat ? `<div class="film-place">${esc(st.label)}</div>` : ''}
        <h3 class="film-heading">${esc(st.beat ?? st.label)}</h3>
        ${p.step === 0 ? `<p class="film-premise">${esc(w.premise)}</p>` : ''}
        ${article}
        ${facts}
        ${who}
        ${pictures}
        ${footer}
        ${this.aroundView(p)}`;
  }

  /**
   * "Où aller ensuite ?": the way on along the planned route first, then the
   * turning points (a branch of this path), then the detours (a few steps,
   * then back here), folded under their count to leave the article room;
   * at the end of the path, the ways on.
   */
  private cross(p: Path): string {
    const w = p.walk;
    const st = w.steps[p.step]!;
    const next = w.steps[p.step + 1];
    const parent = p.parent && this.journal.get(p.parent.id);
    const on = next
      ? `<button type="button" class="cross-next" data-act="next" title="L’étape suivante du chemin prévu (→)">
          <span class="cross-verb">Continuer ▸</span>
          <b>${esc(st.next ?? next.beat ?? `Aller à ${next.place}`)}</b>
          <small>${esc(next.place)} · ${esc(formatWhen(next))}</small>
        </button>`
      : `<div class="cross-end">
          <span class="cross-verb">Fin de ce chemin</span>
          <div class="cross-end-acts">
            ${parent ? `<button type="button" class="sc-btn sc-primary" data-act="back">↩ Revenir à « ${esc(parent.walk.title)} »</button>` : ''}
            <button type="button" class="sc-btn${parent ? '' : ' sc-primary'}" data-act="drawer" data-view="suites">Et ensuite ? ▸</button>
            <button type="button" class="sc-link" data-act="finish">Terminer ✓</button>
          </div>
        </div>`;
    const forks = (st.forks ?? []).map((f, k) => {
      const to = f.steps[0];
      const taken = this.journal.get(`${w.id}|bifurcation|${p.step}|${k}`);
      return `<button type="button" class="cross-fork" data-act="fork" data-i="${k}" title="Une autre suite de l’histoire : une branche de ce chemin, vous pourrez revenir ici">
          ${f.hero ? face(f.hero) : '<span class="cross-icon" aria-hidden="true">⑂</span>'}
          <span class="cross-text"><b>${esc(f.label)}</b><small>${f.hero ? `avec ${esc(f.hero.name)} · ` : ''}${to ? `${esc(to.place)} · ${esc(formatWhen(to))}` : ''}${taken ? ` · ${taken.done ? 'parcourue' : `reprendre ${taken.step + 1}/${taken.walk.steps.length}`}` : ''}</small></span>
        </button>`;
    }).join('');
    // Someone a turning point follows is no detour as well.
    const followed = new Set((st.forks ?? []).flatMap((f) => (f.hero ? [f.hero.qid] : [])));
    let shown = 0;
    const choices = st.text ? (st.choices ?? []).map((c, k) => {
      if (c.person && followed.has(c.person.qid)) return '';
      shown++;
      const where = c.person ? `quelques moments de sa vie, puis retour` : c.poi ? `${c.poi.title}, puis retour` : c.step ? `${c.step.place} · ${formatWhen(c.step)}, puis la suite` : '';
      return `<button type="button" class="cross-detour${st.chosen === k ? ' on' : ''}" data-act="choice" data-i="${k}" title="Un détour, puis retour sur le chemin">
          ${c.person ? face(c.person) : '<span class="cross-icon" aria-hidden="true">↪</span>'}
          <span class="cross-text"><b>${esc(c.label)}</b><small>${esc(where)}</small></span>
        </button>`;
    }).join('') : '';
    const asked = new Set((st.choices ?? []).flatMap((c) => (c.person ? [c.person.qid] : [])));
    // The protagonist's whole life is another suite (a branch); someone met, a detour or theirs.
    const life = this.leads.map((l, i) => (l.kind === 'person' && l.hero
      ? `<button type="button" class="cross-fork" data-act="lead" data-i="${i}" data-how="full" title="Toute son histoire, comme une branche de ce chemin">
          ${face(l.person)}<span class="cross-text"><b>Toute la vie ${esc(of(l.person.name))}</b><small>à travers les fiches de sa vie</small></span>
        </button>`
      : '')).join('');
    const people = this.leads.map((l, i) => {
      if (l.kind !== 'person' || l.hero || asked.has(l.person.qid) || followed.has(l.person.qid)) return '';
      shown++;
      return `<div class="cross-person">${face(l.person)}<span class="cross-text"><b>${esc(l.person.name)}</b><small>${esc(l.person.role)}</small></span>
          <button type="button" class="cn-go" data-act="lead" data-i="${i}" data-how="detour" title="Quelques moments de sa vie autour de celui-ci, puis retour ici">détour</button><button type="button" class="cn-go" data-act="lead" data-i="${i}" data-how="full" title="Toute son histoire, comme une branche de ce chemin">sa vie</button></div>`;
    }).join('');
    const detours = choices + people;
    const turns = forks + life;
    const nTurns = (st.forks?.length ?? 0) + this.leads.filter((l) => l.kind === 'person' && l.hero).length;
    const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
    const count = [nTurns ? `⑂ ${plural(nTurns, 'bifurcation')}` : '', shown ? `↩ ${plural(shown, 'détour')}` : ''].filter(Boolean).join(' · ');
    const open = this.crossOpen || !next;
    return `<div class="film-cross${open ? ' open' : ''}" role="group" aria-label="Où aller ensuite ?">
        <div class="cross-head">
          <span class="cross-title">${next ? 'Où aller ensuite ?' : 'Et maintenant ?'}</span>
          ${count && next ? `<button type="button" class="cross-toggle" data-act="cross" aria-expanded="${open}" title="${open ? 'Replier' : 'Les autres suites et les détours de cette étape'}">${count} ${open ? '▴' : '▾'}</button>` : ''}
        </div>
        ${on}
        ${open && turns ? `<div class="cross-group"><div class="cross-label">⑂ Bifurquer <span>· une autre suite</span></div>${turns}</div>` : ''}
        ${open && detours ? `<div class="cross-group"><div class="cross-label">↩ Détours <span>· puis retour ici</span></div>${detours}</div>` : ''}
      </div>`;
  }

  /** Around the step, folded: the place's own story, what led there and what it caused, what happened meanwhile and close by. */
  private aroundView(p: Path): string {
    const doors = this.stepDoors(p);
    const place = this.leads.map((l, i) => (l.kind === 'place'
      ? `<button type="button" class="film-door" data-act="lead" data-i="${i}" data-how="full" title="Entrer dans l’histoire de ce lieu : ses lieux, ses chemins"><span>⤷</span><span><b>${esc(l.poi.title)}</b><small>son histoire</small></span></button>`
      : '')).join('');
    const door = (kind: keyof StepDoors, icon: string, label: string) => {
      const d = doors?.[kind];
      return d ? `<button type="button" class="film-door" data-act="door" data-kind="${kind}" title="${esc(d.hint)}"><span>${icon}</span><span><b>${esc(d.poi.title)}</b><small>${label}</small></span></button>` : '';
    };
    const st = p.walk.steps[p.step]!;
    const near = (st.near ?? []).map((c, k) => `<div class="film-near">
        <button type="button" class="film-door" data-act="near" data-i="${k}" title="Un détour par « ${esc(c.title)} », puis retour ici"><span>⤴</span><span><b>${esc(c.title)}</b><small>${esc(formatYear(c.date_start))} · détour</small></span></button>
        <button type="button" class="sc-icon" data-act="near-card" data-i="${k}" title="Sa fiche" aria-label="Sa fiche">📄</button>
      </div>`).join('');
    const rows = `${place}${door('cause', '⏪', 'ce qui a mené ici')}${door('effect', '⏩', 'ce que ça a causé')}${door('meanwhile', '🌍', 'pendant ce temps')}`;
    if (!rows && !near) return '';
    return `<details class="film-around"${this.around ? ' open' : ''}>
        <summary>Explorer autour <span>· lieux, causes, pendant ce temps</span></summary>
        <div class="film-around-body">${rows}${near ? `<div class="film-forks-title">Tout près, au même moment</div>${near}` : ''}</div>
      </details>`;
  }

  /** The reel of steps: each with its place and moment; ⑂ where the story may turn. */
  private reel(p: Path): string {
    const w = p.walk;
    const last = p.step + 1 >= w.steps.length;
    const kids = this.journal.children(w.id);
    const thumbs = w.steps.map((s, j) => {
      const turns = (s.forks?.length ?? 0) + kids.filter((k) => k.parent!.step === j && !k.walk.id.startsWith(`${w.id}|bifurcation|${j}|`)).length;
      return `<button type="button" class="film-thumb${j === p.step ? ' on' : j <= p.seen ? ' done' : ''}${s.text ? '' : ' unwritten'}" data-act="dot" data-i="${j}" title="${esc(`${j + 1}. ${s.place} · ${formatWhen(s)}${s.beat ? ` — ${s.beat}` : ''}`)}">
          ${thumbOf(s) ? `<img alt="" src="${esc(viaServer(thumbOf(s)!))}" referrerpolicy="no-referrer" loading="lazy">` : ''}
          <span class="film-thumb-place">${esc(s.place)}</span>
          ${turns ? `<span class="film-thumb-fork" aria-label="bifurcation">⑂</span>` : ''}
        </button>`;
    }).join('');
    return `<div class="film-reel">
        <button type="button" class="sc-icon" data-act="prev" ${p.step === 0 ? 'disabled' : ''} aria-label="Étape précédente" title="Étape précédente (←)">◂</button>
        <div class="film-thumbs" role="group" aria-label="Étapes">${thumbs}</div>
        <button type="button" class="sc-icon film-next" data-act="next" ${last ? 'disabled' : ''} aria-label="Étape suivante" title="Étape suivante (→)">▸</button>
      </div>`;
  }

  /** How many paths the tree of the path played holds (its trunk and every branch). */
  private familyOf(p: Path): number {
    const root = this.ancestors(p)[0] ?? p;
    const seen = new Set<string>();
    const walk = (a: Path) => {
      if (seen.has(a.walk.id)) return;
      seen.add(a.walk.id);
      this.journal.children(a.walk.id).forEach(walk);
    };
    walk(root);
    return seen.size;
  }

  /**
   * A path's steps down a line, the branches hanging under the step they
   * leave: taken (plain, opened when on the way to the path played) or
   * planned and not taken yet (dashed, a click takes them).
   */
  private treeSteps(a: Path, p: Path | null, line: Set<string>, depth = 0): string {
    const kids = this.journal.children(a.walk.id);
    return a.walk.steps.map((s, j) => {
      const here = p?.walk.id === a.walk.id && p.step === j && !this.paused;
      const state = here ? ' here' : j <= a.seen ? ' seen' : '';
      const hanging = kids.filter((k) => k.parent!.step === j);
      const taken = new Set(hanging.map((k) => k.walk.id));
      const branches = hanging.map((k) => {
        const open = line.has(k.walk.id) && depth < 6;
        const n = k.walk.steps.length;
        return `<li class="tr-branch ${k.kind}${open ? ' open' : ''}">
            <button type="button" class="tr-head" data-act="path" data-id="${esc(k.walk.id)}" title="${k.done ? 'Revivre ce chemin' : 'Reprendre ce chemin'}">
              <span class="tr-icon" aria-hidden="true">${KIND_ICONS[k.kind]}</span><span class="tr-text"><b>${esc(k.walk.title)}</b><small>${KIND_LABELS[k.kind]} · ${k.done ? 'terminé' : `${k.seen + 1}/${n}`}</small></span>
            </button>
            ${open ? `<ol class="tr">${this.treeSteps(k, p, line, depth + 1)}</ol>` : ''}
          </li>`;
      }).join('');
      const ghosts = (s.forks ?? []).map((f, k) => (taken.has(`${a.walk.id}|bifurcation|${j}|${k}`) ? '' : `<li class="tr-branch ghost">
          <button type="button" class="tr-head" data-act="tree-fork" data-id="${esc(a.walk.id)}" data-step="${j}" data-i="${k}" title="Une autre suite, pas encore prise : la prendre">
            <span class="tr-icon" aria-hidden="true">┄</span><span class="tr-text"><b>${esc(f.label)}</b><small>${f.hero ? `avec ${esc(f.hero.name)} · ` : ''}${f.steps[0] ? `${esc(f.steps[0].place)} · ` : ''}pas encore prise</small></span>
          </button>
        </li>`)).join('');
      return `<li class="tr-step${state}">
          <button type="button" class="tr-row" data-act="tree-step" data-id="${esc(a.walk.id)}" data-step="${j}">
            <span class="tr-dot" aria-hidden="true"></span>
            <span class="tr-text"><b>${esc(s.place)}</b><small>${esc(formatWhen(s))}${s.beat ? ` · ${esc(s.beat)}` : ''}</small></span>
          </button>
          ${branches || ghosts ? `<ul class="tr-branches">${branches}${ghosts}</ul>` : ''}
        </li>`;
    }).join('');
  }

  /** Titanic › étape 4 › Andrews (détour): the paths it hangs from, shown only when it does. */
  private crumbs(p: Path): string {
    const chain = [...this.ancestors(p), p];
    if (chain.length < 2) return '';
    const parts = chain.slice(0, -1).map((a, k) => {
      const at = chain[k + 1]!.parent!.step;
      return `<button type="button" class="cn-crumb" data-act="crumb" data-id="${esc(a.walk.id)}" data-step="${at}" title="Revenir à ce chemin, à l’étape d’où part la branche">${esc(a.walk.title)} · ${at + 1}</button><span class="cn-sep" aria-hidden="true">›</span>`;
    }).join('');
    return `<nav class="cn-crumbs" aria-label="Fil des chemins">${parts}<span class="cn-crumb here">${KIND_LABELS[p.kind].toLowerCase()}</span></nav>`;
  }

  private drawerView(d: Drawer, p: Path | null): string {
    const body = d === 'here' && this.here ? this.hereView(this.here, p)
      : d === 'tree' ? this.forestView(p)
      : d === 'suites' && p ? this.suites(p)
      : this.pathsView(p);
    return `<section class="film-drawer panel" role="dialog" aria-label="Chemins">
        <button type="button" class="sc-icon film-drawer-close" data-act="close-drawer" title="Fermer (Échap)" aria-label="Fermer">✕</button>
        <div class="cn-body">${body}</div>
      </section>`;
  }

  /** The end of a path: ways on, never a dead end. */
  private suites(p: Path): string {
    const parent = p.parent && this.journal.get(p.parent.id);
    const st = p.walk.steps[p.step]!;
    this.leads = stepLeads(p.walk, p.step);
    this.afterShown = p.walk.after ?? [];
    this.walksShown = throughPlace(this.mergedKnown(), p.walk, p.step);
    const after = this.afterShown.map((l, i) => `<div class="cn-fork">
        <span class="cn-fork-mark cn-place" aria-hidden="true">⏩</span>
        <span class="cn-fork-text"><b>${esc(l.poi.title)}</b><small>${esc(`${l.label} · ${formatYear(l.year)}`)}</small></span>
        <button type="button" class="cn-go" data-act="after-paths" data-i="${i}">Ses chemins</button>
        <button type="button" class="cn-go" data-act="card" data-after="${i}">La fiche</button>
      </div>`).join('');
    const people = this.leads.map((l, i) => (l.kind === 'person' ? `<div class="cn-fork">
        ${face(l.person)}
        <span class="cn-fork-text"><b>${esc(l.person.name)}</b><small>${esc(l.hero ? 'Le personnage de ce chemin' : l.person.role)}</small></span>
        <button type="button" class="cn-go" data-act="lead" data-i="${i}" data-how="full">Tout son chemin</button>
      </div>` : '')).join('');
    const others = this.walksShown.map((w, i) => this.walkRow(w, i, p)).join('');
    return `<div class="cn-kicker">Fin de « ${esc(p.walk.title)} »</div>
      <h2 class="cn-title">Et ensuite ?</h2>
      ${parent ? `<button type="button" class="sc-btn sc-primary cn-back" data-act="back">↩ Revenir à « ${esc(parent.walk.title)} » · étape ${p.parent!.step + 1}</button>` : ''}
      ${people ? `<section class="cn-forks"><div class="cn-forks-title">Suivre un personnage</div>${people}</section>` : ''}
      ${after ? `<section class="cn-forks"><div class="cn-forks-title">Ce que ça a engendré</div>${after}</section>` : ''}
      ${others ? `<section class="cn-forks"><div class="cn-forks-title">D’autres chemins par ${esc(st.place)}</div>${others}</section>` : ''}
      <footer class="sc-foot"><button type="button" class="sc-link cn-finish" data-act="finish">Terminer ce chemin ✓</button></footer>`;
  }

  /** Walks known: met on cards and searches, and the paths started. */
  private mergedKnown(): ScenarioWalk[] {
    const out = new Map<string, ScenarioWalk>();
    for (const p of this.journal.list()) out.set(p.walk.id, p.walk);
    for (const w of this.known()) if (!out.has(w.id)) out.set(w.id, w);
    return [...out.values()];
  }

  /** A walk offered: its state (start, resume, played) and, while another is played, branching off to it. */
  private walkRow(w: ScenarioWalk, i: number, playing: Path | null): string {
    const known = this.journal.get(w.id);
    const mine = this.current === w.id && !this.paused;
    const go = mine ? 'En cours ●' : known && !known.done ? `Reprendre · étape ${known.step + 1} ▸` : known?.done ? 'Revivre ↺' : 'Commencer ▸';
    const who = w.invented ? 'Fil thématique' : `Personnage réel${w.hero ? ` · ${esc(w.hero.name)}` : ''}`;
    const branch = playing && playing.walk.id !== w.id
      ? `<button type="button" class="cn-go" data-act="branch" data-i="${i}" title="L’ouvrir comme une branche du chemin en cours">⑂ Bifurquer ici</button>`
      : '';
    return `<div class="cn-walk${mine ? ' playing' : ''}">
        <div class="cn-walk-badges"><span class="story-sc-kind ${w.invented ? 'invented' : 'real'}">${who}</span><span class="story-sc-len">${w.steps.length} étapes${w.from ? ` · ${esc(w.from.title)}` : ''}</span></div>
        <div class="cn-walk-title">🎭 ${esc(w.title)}</div>
        <div class="cn-walk-premise">${esc(w.premise)}</div>
        <div class="cn-walk-acts">
          <button type="button" class="sc-btn sc-primary" data-act="walk" data-i="${i}" ${mine ? 'disabled' : ''}>${go}</button>${branch}
        </div>
      </div>`;
  }

  private hereView(h: Here, p: Path | null): string {
    this.leads = [];
    this.afterShown = [];
    this.walksShown = h.walks;
    const year = p?.walk.steps[p.step]?.year;
    const life = h.person
      ? `<div class="cn-fork cn-life">
          ${face(h.person)}
          <span class="cn-fork-text"><b>Suivre la vie de ${esc(h.person.name)}</b><small>Étape par étape, à travers les fiches de sa vie</small></span>
          ${p && year !== undefined ? `<button type="button" class="cn-go" data-act="life" data-how="detour" title="Quelques étapes de sa vie autour de ${esc(formatYear(year))}">Un détour (${esc(formatYear(year))})</button>` : ''}
          <button type="button" class="cn-go cn-go-main" data-act="life" data-how="full">Tout son chemin ▸</button>
        </div>`
      : '';
    const state = h.status === 'pending' ? `<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>${h.walks.length ? 'L’IA écrit d’autres chemins…' : 'L’IA trace les chemins qui passent ici…'}</div>`
      : h.status === 'no-ai' && !h.walks.length ? '<p class="cn-empty">Aucune IA disponible pour tracer des chemins pour le moment.</p>'
      : !h.walks.length && !h.person ? '<p class="cn-empty">Aucun chemin ne passe encore par ici.</p>'
      : '';
    return `
      <div class="cn-kicker">Chemins qui passent par</div>
      <h2 class="cn-title">${esc(h.title)}</h2>
      ${life}
      <div class="cn-walks">${h.walks.map((w, i) => this.walkRow(w, i, p)).join('')}</div>
      ${state}
      ${h.poi ? '<footer class="sc-foot"><button type="button" class="sc-link" data-act="card">Explorer sa fiche et tous ses lieux ⤷</button></footer>' : ''}`;
  }

  private pathsView(p: Path | null): string {
    const paths = this.journal.list();
    if (!paths.length) {
      return `<div class="cn-kicker">Mes chemins</div>
        <p class="cn-empty">Aucun chemin commencé. Ouvrez une fiche : « ▶ Parcourir cette histoire » propose ses parcours.</p>`;
    }
    const rows = paths.map((a) => {
      const n = a.walk.steps.length;
      const parent = a.parent && this.journal.get(a.parent.id);
      const meta = [parent ? `${KIND_LABELS[a.kind]} de « ${parent.walk.title} »` : KIND_LABELS[a.kind], a.walk.hero?.name ?? (a.walk.invented ? 'Fil thématique' : '')].filter(Boolean).join(' · ');
      const mine = a.walk.id === p?.walk.id;
      return `<div class="cn-path${mine ? ' playing' : ''}">
          <button type="button" class="cn-path-main" data-act="path" data-id="${esc(a.walk.id)}" title="${a.done ? 'Revivre ce chemin' : 'Reprendre à l’étape où vous étiez'}">
            <b>${esc(a.walk.title)}</b>
            <small>${esc(meta)}</small>
            <span class="cn-bar" aria-hidden="true"><i style="width:${Math.round(((a.seen + 1) / n) * 100)}%"></i></span>
            <small class="cn-path-state">${mine ? (this.paused ? `En pause · étape ${a.step + 1}/${n}` : `En cours · étape ${a.step + 1}/${n}`) : a.done ? 'Terminé · revivre ↺' : `Reprendre · étape ${a.step + 1}/${n} ▸`}</small>
          </button>
          ${mine ? '' : `<button type="button" class="cn-forget" data-act="forget" data-id="${esc(a.walk.id)}" title="Oublier ce chemin" aria-label="Oublier ce chemin">×</button>`}
        </div>`;
    }).join('');
    return `<div class="cn-kicker">Mes chemins <span class="cn-aside">· gardés dans ce navigateur</span></div>
      <div class="cn-paths">${rows}</div>
      <footer class="sc-foot"><button type="button" class="sc-link" data-act="drawer" data-view="tree">⑂ Voir les arbres des chemins</button></footer>`;
  }

  /** Every story explored, as a tree each: its trunk's steps, the branches under the step they leave. */
  private forestView(p: Path | null): string {
    const roots = this.journal.list().filter((a) => !(a.parent && this.journal.get(a.parent.id)));
    if (!roots.length) return '<div class="cn-kicker">Les arbres des chemins</div><p class="cn-empty">Aucun chemin exploré pour le moment.</p>';
    const line = new Set(p ? [...this.ancestors(p), p].map((a) => a.walk.id) : []);
    return `<div class="cn-kicker">Les arbres des chemins <span class="cn-aside">· pris en plein, non pris en pointillés</span></div>
      ${roots.map((r, i) => `<details class="tr-root"${i === 0 || line.has(r.walk.id) ? ' open' : ''}>
          <summary><b>${esc(r.walk.title)}</b><small>${esc(r.walk.hero?.name ?? (r.walk.invented ? 'Fil thématique' : ''))} · ${r.done ? 'terminé' : `${r.seen + 1}/${r.walk.steps.length}`}</small></summary>
          <ol class="tr">${this.treeSteps(r, p, line)}</ol>
        </details>`).join('')}`;
  }
}

/** Scenarios met so far, for the search bar (kept in this browser only). */
const LIBRARY_KEY = 'orbis:scenarios';
const LIBRARY_MAX = 40;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export class ScenarioLibrary {
  private walks: ScenarioWalk[] = [];

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]') as ScenarioWalk[];
      if (Array.isArray(raw)) this.walks = raw.filter((w) => w && typeof w.id === 'string' && Array.isArray(w.steps));
    } catch {
      /* storage unavailable: the library starts empty */
    }
  }

  get all(): ScenarioWalk[] {
    return this.walks;
  }

  /** Remembers scenarios shown on a card or written for a person (the latest first). */
  add(walks: ScenarioWalk[]): void {
    const ids = new Set(walks.map((w) => w.id));
    this.walks = [...walks, ...this.walks.filter((w) => !ids.has(w.id))].slice(0, LIBRARY_MAX);
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.walks));
    } catch {
      /* not remembered */
    }
  }

  /** Scenarios whose title, premise, person, card or places name every word asked. */
  search(q: string, limit = 5): ScenarioWalk[] {
    const words = fold(q).split(/\s+/).filter((w) => w.length >= 2);
    if (!words.length) return [];
    return this.walks.filter((w) => {
      const text = fold([w.title, w.premise, w.hero?.name ?? '', w.from?.title ?? '', ...w.steps.map((s) => s.place)].join(' '));
      return words.every((x) => text.includes(x));
    }).slice(0, limit);
  }

  /** Scenarios passing through a card (written on it, or with a step there), or following a person. */
  through(at: { poi?: PoiLite; qid?: string }): ScenarioWalk[] {
    return this.walks.filter((w) => at.poi
      ? w.from?.id === at.poi.id || w.steps.some((s) => s.poi?.id === at.poi!.id || km(s, at.poi!) < SAME_PLACE_KM / 4)
      : w.hero?.qid === at.qid || w.steps.some((s) => s.cast.some((c) => c.qid === at.qid)));
  }
}
