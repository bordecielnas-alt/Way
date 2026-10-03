import { formatYear, type PoiLite, type ScenarioWalk, type StoryPerson, type WalkLead } from '@way/shared';
import { viaServer } from './media.ts';

// The carnet de route: scenarios live on their own, in a full-screen,
// see-through layer over the globe, apart from the cards. The globe flies
// from step to step behind it; "Regarder la carte" folds it to a pill.
// Every scenario started is a path, kept in "Mes chemins" with its progress.
// Paths branch: at each step, crossroads (the people present, the place)
// open a short detour or their whole path, remembered as a branch of the one
// played; a breadcrumb climbs back up, a tree shows all the paths explored.
// At the end of a path, ways on: a person, what it led to, another path
// through the same place, or back to the trunk.

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

type View = 'step' | 'paths' | 'here' | 'tree';

const KIND_LABELS: Record<PathKind, string> = { trunk: 'Chemin', detour: 'Détour', branch: 'Branche' };
/** Paths remembered in this browser. */
const PATHS_KEY = 'orbis:paths';
const PATHS_MAX = 60;
/** Two steps closer than this pass through the same place. */
const SAME_PLACE_KM = 40;
const MAX_FORKS = 3;

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

export class Carnet {
  private journal = new Journal();
  private current: string | null = null;
  /** Clicked elsewhere: the path waits, its people leave the map. */
  private paused = false;
  /** The carnet is shown over the globe (folded: a pill). */
  private open = false;
  private view: View = 'step';
  private here: Here | null = null;
  /** Something being prepared (a detour, a life written by an AI). */
  private note: string | null = null;
  /** What the buttons of the view shown point to. */
  private leads: Lead[] = [];
  private walksShown: ScenarioWalk[] = [];
  private afterShown: WalkLead[] = [];

  /** A step to show: map, timeline and its people go there. */
  onStep: (walk: ScenarioWalk, step: number) => void = () => undefined;
  /** Paused: the people of the step leave the map. */
  onPause: () => void = () => undefined;
  /** No path played any more: `restore`, the view comes back to where it was before. */
  onEnd: (restore: boolean) => void = () => undefined;
  /** The path played, its step or its state changed (cards mark it). */
  onChange: () => void = () => undefined;
  /** A card to open (the carnet folds first). */
  onOpenCard: (poi: PoiLite) => void = () => undefined;
  /** A crossroads taken: a short detour around the step's year, or the whole path. */
  onLead: (lead: Lead, how: 'detour' | 'full', at: LeadFrom) => void = () => undefined;
  /** A walk met: remembered for the search bar. */
  onMet: (walk: ScenarioWalk) => void = () => undefined;

  constructor(private root: HTMLElement, private known: () => ScenarioWalk[]) {
    root.addEventListener('click', (e) => this.click(e));
    // Before the card and the timeline: while the carnet is open, its keys are its own.
    window.addEventListener('keydown', (e) => {
      if (!this.open || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      const step = this.view === 'step' && this.playingPath && !this.paused;
      if (e.key === 'Escape') this.fold();
      else if (step && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) this.go(e.key === 'ArrowRight' ? 1 : -1);
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

  /** Shown over the globe (not folded). */
  get isOpen(): boolean {
    return this.open;
  }

  /** What is known of a path (its progress), for the cards. */
  pathOf(id: string): Path | undefined {
    return this.journal.get(id);
  }

  /**
   * Plays a walk from a step. `branch`: hung on the path played, as a detour
   * or a branch; otherwise a path keeps its place in the tree (a new one is a trunk).
   */
  play(walk: ScenarioWalk, step = 0, branch?: PathKind): void {
    if (!walk.steps[step]) return;
    const from = this.playingPath;
    const now = Date.now();
    const p: Path = this.journal.get(walk.id) ?? { walk, step, seen: step, done: false, kind: 'trunk', parent: null, at: now };
    p.walk = walk;
    p.step = step;
    p.seen = Math.max(p.seen, step);
    p.at = now;
    if (branch && from && from.walk.id !== walk.id && !this.ancestors(from).some((a) => a.walk.id === walk.id)) {
      p.kind = branch;
      p.parent = { id: from.walk.id, step: from.step };
    }
    this.journal.put(p);
    this.onMet(walk);
    this.current = walk.id;
    this.paused = false;
    this.open = true;
    this.view = 'step';
    this.note = null;
    this.show();
  }

  /** Clicked elsewhere on the globe: the path waits and the carnet folds; with none played, it closes. */
  pause(): void {
    if (!this.playingPath) {
      if (this.open) this.close();
      return;
    }
    if (this.paused) return;
    this.paused = true;
    this.open = false;
    this.onPause();
    this.render();
    this.onChange();
  }

  resume(): void {
    const p = this.playingPath;
    if (!p) return;
    this.play(p.walk, p.step);
  }

  /** "Regarder la carte": the carnet folds to a pill, the path goes on (its people stay on the map). */
  fold(): void {
    if (!this.playingPath) return this.close();
    this.open = false;
    this.render();
  }

  unfold(view: View = 'step'): void {
    this.open = true;
    this.view = view;
    this.render();
  }

  /** Leaves the path played: back up to the one it branched off, else to the view of before. */
  quit(): void {
    const p = this.playingPath;
    if (!p) return this.close();
    const parent = p.parent && this.journal.get(p.parent.id);
    if (parent) {
      this.play(parent.walk, Math.min(p.parent!.step, parent.walk.steps.length - 1));
      return;
    }
    this.current = null;
    this.paused = false;
    this.open = false;
    this.onEnd(true);
    this.render();
    this.onChange();
  }

  /** Scenarios turned off: everything stops where it is. */
  stop(): void {
    this.note = null;
    this.here = null;
    this.open = false;
    const had = !!this.current;
    this.current = null;
    this.paused = false;
    if (had) this.onEnd(false);
    this.render();
    this.onChange();
  }

  /** The paths through a place or a person, in the carnet. */
  showHere(here: Here): void {
    this.here = here;
    this.unfold('here');
  }

  /** New paths for the place or person shown (written meanwhile). */
  updateHere(here: Here): void {
    if (this.here?.key !== here.key) return;
    this.here = here;
    if (this.open && this.view === 'here') this.render();
  }

  get hereKey(): string | null {
    return this.here?.key ?? null;
  }

  showPaths(): void {
    this.unfold('paths');
  }

  /** What is being prepared ("L'IA écrit un détour…"), or null. */
  setNote(text: string | null): void {
    this.note = text;
    this.render();
  }

  private close(): void {
    this.open = false;
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
    this.paused = false;
    this.view = 'step';
    this.show();
  }

  private finish(): void {
    const p = this.playingPath;
    if (p) {
      p.done = true;
      this.journal.save();
    }
    this.quit();
  }

  private show(): void {
    const p = this.playingPath!;
    // Laid out first: the map flies to the part the carnet leaves visible.
    this.render();
    this.onStep(p.walk, p.step);
    this.onChange();
  }

  private click(e: MouseEvent): void {
    const b = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!b || !this.root.contains(b)) return;
    const p = this.playingPath;
    const n = Number(b.dataset.i);
    const walkAt = () => this.walksShown[n];
    switch (b.dataset.act) {
      case 'tab':
        if (b.dataset.view === 'step' && this.paused) this.resume();
        else this.unfold(b.dataset.view as View);
        return;
      case 'fold': return this.fold();
      case 'unfold': return this.unfold();
      case 'resume': return this.resume();
      case 'quit': return this.quit();
      case 'close': return this.close();
      case 'prev': return this.go(-1);
      case 'next': return this.go(1);
      case 'dot': return this.goto(n);
      case 'finish': return this.finish();
      case 'back': return this.quit();
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
      case 'forget':
        if (b.dataset.id === this.current) return;
        this.journal.remove(b.dataset.id!);
        return this.render();
      case 'lead': {
        const lead = this.leads[n];
        if (lead && p) this.onLead(lead, b.dataset.how as 'detour' | 'full', { year: p.walk.steps[p.step]!.year, walk: p.walk });
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
        if (!poi) return;
        if (p) this.pause();
        else this.close();
        this.onOpenCard(poi);
        return;
      }
      case 'life':
        if (this.here?.person) {
          this.onLead({ kind: 'person', person: this.here.person }, b.dataset.how as 'detour' | 'full', { year: p?.walk.steps[p.step]!.year ?? 0, walk: p?.walk ?? null });
        }
        return;
    }
  }

  private render(): void {
    const p = this.playingPath;
    document.body.classList.toggle('scenario-on', !!p && !this.paused);
    document.body.classList.toggle('carnet-open', this.open);
    const note = this.note ? `<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>${esc(this.note)}</div>` : '';
    const count = this.journal.list().length;
    this.root.hidden = !this.open && !p && !this.note && !count;
    if (!this.open) {
      this.root.className = 'carnet folded';
      // Nothing played: a way back to the paths already explored.
      const launch = `<button type="button" class="carnet-launch panel" data-act="tab" data-view="paths" title="Ouvrir le carnet de route">🎭 Mes chemins <span class="cn-count">${count}</span></button>`;
      this.root.innerHTML = p ? this.pill(p, note) : note ? `<div class="carnet-pill panel">${note}</div>` : launch;
      return;
    }
    if (this.view === 'step' && (!p || this.paused)) this.view = p ? 'step' : 'paths';
    this.root.className = 'carnet open';
    const tab = (view: View, label: string, disabled = false) =>
      `<button type="button" class="cn-tab${this.view === view ? ' on' : ''}" data-act="tab" data-view="${view}" ${disabled ? 'disabled' : ''}>${label}</button>`;
    const body = this.view === 'step' && p ? this.stepView(p)
      : this.view === 'here' && this.here ? this.hereView(this.here, p)
      : this.view === 'tree' ? this.treeView(p)
      : this.pathsView(p);
    this.root.innerHTML = `
      <div class="carnet-sheet" role="dialog" aria-label="Carnet de route">
        <header class="cn-top">
          <span class="cn-brand">🎭 Carnet de route</span>
          <nav class="cn-tabs">
            ${tab('step', p ? (this.paused ? 'Reprendre' : 'En cours') : 'En cours', !p)}
            ${tab('paths', `Mes chemins${count ? ` <span class="cn-count">${count}</span>` : ''}`)}
            ${this.here ? tab('here', `Ici : ${esc(this.here.title)}`) : ''}
          </nav>
          <span class="cn-top-acts">
            <button type="button" class="sc-btn cn-fold" data-act="fold" title="Replier le carnet et regarder la carte (Échap)">🗺 Regarder la carte</button>
            <button type="button" class="sc-icon sc-quit" data-act="${p ? 'quit' : 'close'}" title="${p ? (p.parent ? 'Quitter ce chemin et revenir à celui d’où il part' : 'Quitter ce chemin et revenir à la vue d’avant') : 'Fermer le carnet'}" aria-label="${p ? 'Quitter ce chemin' : 'Fermer'}">✕</button>
          </span>
        </header>
        ${p ? this.crumbs(p) : ''}
        ${note}
        <div class="cn-body">${body}</div>
      </div>`;
    this.root.querySelectorAll<HTMLImageElement>('img').forEach((img) => img.addEventListener('error', () => img.remove()));
  }

  private pill(p: Path, note: string): string {
    const n = p.walk.steps.length;
    const text = `<b>${esc(p.walk.title)}</b> · étape ${p.step + 1}/${n}`;
    return `<div class="carnet-pill panel">
        <div class="sc-pill">
          <span class="sc-pill-icon" aria-hidden="true">${this.paused ? '⏸' : '🎭'}</span>
          <span class="sc-pill-text">${this.paused ? '' : '<span class="sc-live" aria-hidden="true"></span> '}${text}</span>
          ${this.paused
            ? '<button type="button" class="sc-btn sc-primary" data-act="resume">Reprendre ▸</button>'
            : '<button type="button" class="sc-btn sc-primary" data-act="unfold">Rouvrir le carnet ▸</button>'}
          <button type="button" class="sc-icon sc-quit" data-act="quit" title="Quitter ce chemin" aria-label="Quitter ce chemin">✕</button>
        </div>${note}
      </div>`;
  }

  /** Titanic › étape 4 › Andrews (détour) › étape 2, and the tree. */
  private crumbs(p: Path): string {
    const chain = [...this.ancestors(p), p];
    const parts = chain.map((a, k) => {
      const next = chain[k + 1];
      if (!next) return `<span class="cn-crumb here">${esc(a.walk.title)}${a.kind === 'trunk' ? '' : ` <small>${KIND_LABELS[a.kind].toLowerCase()}</small>`}</span>`;
      const at = next.parent!.step;
      return `<button type="button" class="cn-crumb" data-act="crumb" data-id="${esc(a.walk.id)}" data-step="${at}" title="Revenir à ce chemin, à l’étape d’où part la branche">${esc(a.walk.title)} · étape ${at + 1}</button><span class="cn-sep" aria-hidden="true">›</span>`;
    }).join('');
    return `<nav class="cn-crumbs" aria-label="Fil des chemins">${parts}
      <button type="button" class="cn-tree-btn${this.view === 'tree' ? ' on' : ''}" data-act="tab" data-view="tree" title="L’arbre des chemins explorés">🌳 Arbre</button></nav>`;
  }

  private stepView(p: Path): string {
    const w = p.walk;
    const n = w.steps.length;
    const st = w.steps[p.step]!;
    const last = p.step + 1 >= n;
    const who = w.invented ? 'Personnage inventé' : `Personnage réel${w.hero ? ` · ${esc(w.hero.name)}` : ''}`;
    const cast = st.cast.filter((c) => c.qid !== w.hero?.qid).map((c) => c.name);
    this.leads = stepLeads(w, p.step);
    this.walksShown = [];
    this.afterShown = [];
    return `
      <div class="cn-kicker"><span class="sc-live" aria-hidden="true"></span>${who}${p.kind !== 'trunk' ? ` · <span class="cn-kind">${KIND_LABELS[p.kind]}</span>` : ''}</div>
      <h2 class="cn-title">${esc(w.title)}</h2>
      <p class="cn-premise">${esc(w.premise)}</p>
      <div class="sc-progress" role="group" aria-label="Étapes">${w.steps.map((s, j) =>
        `<button type="button" class="sc-dot${j === p.step ? ' on' : j <= p.seen ? ' done' : ''}" data-act="dot" data-i="${j}" title="${esc(`${j + 1}. ${s.place} · ${formatYear(s.year)}`)}" aria-label="Étape ${j + 1}"></button>`).join('')}</div>
      <article class="cn-step">
        <div class="sc-step-head">Étape ${p.step + 1}/${n} · ${esc(st.place)} · ${esc(formatYear(st.year))}${st.label ? ` <span class="sc-step-label">· ${esc(st.label)}</span>` : ''}</div>
        <p class="cn-step-text">${esc(st.text)}</p>
        ${cast.length ? `<div class="sc-step-cast">Avec ${esc(cast.join(', '))}</div>` : ''}
      </article>
      <div class="sc-actions">
        <button type="button" class="sc-btn" data-act="prev" ${p.step === 0 ? 'disabled' : ''}>◂ Précédente</button>
        ${last ? '' : '<button type="button" class="sc-btn sc-primary" data-act="next">Suivante ▸</button>'}
      </div>
      ${last ? this.suites(p) : this.forks('Carrefours', 'Bifurquer ici : un détour de quelques étapes, ou tout son chemin.')}
      <footer class="sc-foot">
        ${w.from ? `<button type="button" class="sc-link" data-act="card" title="Replier le carnet et ouvrir la fiche">Fiche : ${esc(w.from.title)}</button>` : ''}
        <a class="sc-link sc-source" href="${esc(w.source.url)}" target="_blank" rel="noopener">Imaginé par IA d’après « ${esc(w.source.title.replace(/^Wikipédia : /, ''))} »</a>
      </footer>`;
  }

  /** The crossroads of the step (people, place) under a title: a detour, or the whole path. */
  private forks(title: string, aside: string, only?: Lead['kind']): string {
    const rows = this.forkRows(only);
    return rows ? `<section class="cn-forks"><div class="cn-forks-title">${title}${aside ? ` <span class="cn-aside">· ${aside}</span>` : ''}</div>${rows}</section>` : '';
  }

  private forkRows(only?: Lead['kind']): string {
    return this.leads.map((l, i) => {
      if (only && l.kind !== only) return '';
      const icon = l.kind === 'person'
        ? `<span class="cn-fork-mark">${l.person.image ? `<img alt="" src="${esc(viaServer(l.person.image))}" referrerpolicy="no-referrer">` : esc(l.person.name.charAt(0))}</span>`
        : '<span class="cn-fork-mark cn-place" aria-hidden="true">📍</span>';
      const name = l.kind === 'person' ? l.person.name : l.poi.title;
      const meta = l.kind === 'person' ? (l.hero ? 'Le personnage de ce chemin : toute sa vie' : l.person.role) : 'Le lieu de cette étape';
      // The protagonist's detour would walk this very story again: only their whole life.
      const detour = l.kind === 'person' && l.hero ? ''
        : `<button type="button" class="cn-go" data-act="lead" data-i="${i}" data-how="detour" title="Quelques étapes autour de ce moment, puis retour ici">Un détour</button>`;
      return `<div class="cn-fork">${icon}
        <span class="cn-fork-text"><b>${esc(name)}</b><small>${esc(meta)}</small></span>
        ${detour}
        <button type="button" class="cn-go" data-act="lead" data-i="${i}" data-how="full" title="${l.kind === 'person' ? 'Toute son histoire, comme une branche de ce chemin' : 'Les chemins qui passent par ce lieu'}">${l.kind === 'person' ? 'Tout son chemin' : 'Ses chemins'}</button>
      </div>`;
    }).join('');
  }

  /** The end of a path: ways on, never a dead end. */
  private suites(p: Path): string {
    const parent = p.parent && this.journal.get(p.parent.id);
    const st = p.walk.steps[p.step]!;
    this.afterShown = p.walk.after ?? [];
    this.walksShown = throughPlace(this.mergedKnown(), p.walk, p.step);
    const after = this.afterShown.map((l, i) => `<div class="cn-fork">
        <span class="cn-fork-mark cn-place" aria-hidden="true">⏩</span>
        <span class="cn-fork-text"><b>${esc(l.poi.title)}</b><small>${esc(`${l.label} · ${formatYear(l.year)}`)}</small></span>
        <button type="button" class="cn-go" data-act="after-paths" data-i="${i}">Ses chemins</button>
        <button type="button" class="cn-go" data-act="card" data-after="${i}">La fiche</button>
      </div>`).join('');
    const others = this.walksShown.map((w, i) => this.walkRow(w, i, p)).join('') + this.forkRows('place');
    return `<section class="cn-suites">
        <div class="cn-forks-title cn-end-title">Fin de ce chemin. Et ensuite ?</div>
        ${parent ? `<button type="button" class="sc-btn sc-primary cn-back" data-act="back">↩ Revenir à « ${esc(parent.walk.title)} » · étape ${p.parent!.step + 1}</button>` : ''}
        ${this.forks('Suivre un personnage', 'un détour ou toute son histoire', 'person')}
        ${after ? `<section class="cn-forks"><div class="cn-forks-title">Ce que ça a engendré</div>${after}</section>` : ''}
        ${others ? `<section class="cn-forks"><div class="cn-forks-title">D’autres chemins par ${esc(st.place)}</div>${others}</section>` : ''}
        <button type="button" class="sc-link cn-finish" data-act="finish">Terminer ce chemin ✓</button>
      </section>`;
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
    const who = w.invented ? 'Personnage inventé' : `Personnage réel${w.hero ? ` · ${esc(w.hero.name)}` : ''}`;
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
          <span class="cn-fork-mark">${h.person.image ? `<img alt="" src="${esc(viaServer(h.person.image))}" referrerpolicy="no-referrer">` : esc(h.person.name.charAt(0))}</span>
          <span class="cn-fork-text"><b>Vivre l’histoire de ${esc(h.person.name)}</b><small>À travers les fiches de sa vie, écrite par l’IA</small></span>
          ${p && year !== undefined ? `<button type="button" class="cn-go" data-act="life" data-how="detour" title="Quelques étapes de sa vie autour de ${esc(formatYear(year))}">Un détour (${esc(formatYear(year))})</button>` : ''}
          <button type="button" class="cn-go cn-go-main" data-act="life" data-how="full">Tout son chemin ▸</button>
        </div>`
      : '';
    const state = h.status === 'pending' ? '<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>L’IA trace les chemins qui passent ici…</div>'
      : h.status === 'no-ai' && !h.walks.length ? '<p class="cn-empty">Aucune IA disponible pour tracer des chemins pour le moment.</p>'
      : !h.walks.length && !h.person ? '<p class="cn-empty">Aucun chemin ne passe encore par ici.</p>'
      : '';
    return `
      <div class="cn-kicker">Chemins qui passent par</div>
      <h2 class="cn-title">${esc(h.title)}</h2>
      ${life}
      <div class="cn-walks">${h.walks.map((w, i) => this.walkRow(w, i, p)).join('')}</div>
      ${state}
      ${h.poi ? '<footer class="sc-foot"><button type="button" class="sc-link" data-act="card">Voir la fiche</button></footer>' : ''}`;
  }

  private pathsView(p: Path | null): string {
    const paths = this.journal.list();
    if (!paths.length) {
      return `<div class="cn-kicker">Mes chemins</div>
        <p class="cn-empty">Aucun chemin commencé. Ouvrez une fiche, un lieu ou un personnage : les chemins qui y passent s’y proposent, en pastille « 🎭 ».</p>`;
    }
    const rows = paths.map((a) => {
      const n = a.walk.steps.length;
      const parent = a.parent && this.journal.get(a.parent.id);
      const meta = [parent ? `${KIND_LABELS[a.kind]} de « ${parent.walk.title} »` : KIND_LABELS[a.kind], a.walk.hero?.name ?? (a.walk.invented ? 'Personnage inventé' : '')].filter(Boolean).join(' · ');
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
      <footer class="sc-foot"><button type="button" class="sc-link" data-act="tab" data-view="tree">🌳 Voir l’arbre des chemins</button></footer>`;
  }

  private treeView(p: Path | null): string {
    const paths = this.journal.list();
    const kids = new Map<string, Path[]>();
    const roots: Path[] = [];
    for (const a of paths) {
      const up = a.parent && this.journal.get(a.parent.id) ? a.parent.id : null;
      if (up) kids.set(up, [...(kids.get(up) ?? []), a]);
      else roots.push(a);
    }
    const seen = new Set<string>();
    const node = (a: Path): string => {
      if (seen.has(a.walk.id)) return '';
      seen.add(a.walk.id);
      const children = (kids.get(a.walk.id) ?? []).sort((x, y) => x.parent!.step - y.parent!.step);
      const n = a.walk.steps.length;
      return `<li>
          <button type="button" class="cn-node${a.walk.id === p?.walk.id ? ' playing' : ''}${a.done ? ' done' : ''}" data-act="path" data-id="${esc(a.walk.id)}">
            ${a.parent ? `<span class="cn-node-at">étape ${a.parent.step + 1} ›</span>` : ''}
            <b>${esc(a.walk.title)}</b>
            <small>${KIND_LABELS[a.kind]} · ${a.done ? 'terminé' : `${a.seen + 1}/${n}`}</small>
          </button>
          ${children.length ? `<ul>${children.map(node).join('')}</ul>` : ''}
        </li>`;
    };
    return `<div class="cn-kicker">L’arbre des chemins <span class="cn-aside">· chaque branche part d’une étape</span></div>
      ${roots.length ? `<ul class="cn-tree">${roots.map(node).join('')}</ul>` : '<p class="cn-empty">Aucun chemin exploré pour le moment.</p>'}`;
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
