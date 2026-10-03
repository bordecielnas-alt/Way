import { formatYear, type ScenarioWalk } from '@way/shared';

// The scenario being played, on its own, above the map: it no longer lives
// in a card. A banner says where the visitor is in it (step n / N, the
// place, what the character lives there) with previous / next, pause and
// quit. Clicking elsewhere on the globe pauses it: the banner folds to a
// pill, "Reprendre" takes the map back to the step. Starting another
// scenario keeps the first one aside, to come back to it.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface Playing {
  walk: ScenarioWalk;
  step: number;
}

export type PlayerState = 'off' | 'playing' | 'paused';

export class ScenarioPlayer {
  private current: Playing | null = null;
  /** The scenario left aside when another one started. */
  private previous: Playing | null = null;
  private paused = false;
  /** Something being prepared (a life written by an AI), said in the banner. */
  private note: string | null = null;

  /** A step to show: map, timeline and its people go there. */
  onStep: (walk: ScenarioWalk, step: number) => void = () => undefined;
  /** Paused: the people of the step leave the map, the visitor explores freely. */
  onPause: () => void = () => undefined;
  /** No scenario any more: `restore`, the view comes back to where it was before the first one. */
  onEnd: (restore: boolean) => void = () => undefined;
  /** The scenario played or its step changed (cards mark it). */
  onChange: () => void = () => undefined;
  /** The card a scenario was written on. */
  onOpenCard: (walk: ScenarioWalk) => void = () => undefined;

  constructor(private root: HTMLElement) {
    this.render();
  }

  get state(): PlayerState {
    return !this.current ? 'off' : this.paused ? 'paused' : 'playing';
  }

  /** The scenario played (or paused) and its step. */
  get playing(): Playing | null {
    return this.current;
  }

  /** Plays a scenario from a step; another one being played is kept aside. */
  play(walk: ScenarioWalk, step = 0): void {
    if (!walk.steps[step]) return;
    if (this.current && this.current.walk.id !== walk.id) this.previous = this.current;
    if (this.previous?.walk.id === walk.id) this.previous = null;
    this.current = { walk, step };
    this.paused = false;
    this.note = null;
    this.show();
  }

  /** Clicked elsewhere: the scenario waits, the map is free. */
  pause(): void {
    if (!this.current || this.paused) return;
    this.paused = true;
    this.onPause();
    this.render();
    this.onChange();
  }

  resume(): void {
    if (!this.current) return;
    this.paused = false;
    this.show();
  }

  /** Quits the scenario played: the one left aside comes back (paused), else the view of before. */
  quit(): void {
    if (!this.current) return;
    if (this.previous) {
      this.current = this.previous;
      this.previous = null;
      this.paused = true;
      this.onPause();
      this.render();
      this.onChange();
      return;
    }
    this.current = null;
    this.paused = false;
    this.onEnd(true);
    this.render();
    this.onChange();
  }

  /** Scenarios turned off: everything stops where it is. */
  stop(): void {
    this.previous = null;
    this.note = null;
    if (!this.current) return this.render();
    this.current = null;
    this.paused = false;
    this.onEnd(false);
    this.render();
    this.onChange();
  }

  /** Back to the scenario left aside, where it was. */
  swap(): void {
    if (!this.previous) return;
    const back = this.previous;
    this.previous = this.current;
    this.current = back;
    this.paused = false;
    this.show();
  }

  /** What is being prepared ("L'IA écrit la vie de…"), or null. */
  setNote(text: string | null): void {
    this.note = text;
    this.render();
  }

  private go(delta: number): void {
    const c = this.current;
    if (!c) return;
    const j = c.step + delta;
    if (j < 0 || j >= c.walk.steps.length) return;
    c.step = j;
    this.paused = false;
    this.show();
  }

  private show(): void {
    const c = this.current!;
    this.onStep(c.walk, c.step);
    this.render();
    this.onChange();
  }

  private render(): void {
    document.body.classList.toggle('scenario-on', this.state === 'playing');
    const c = this.current;
    const note = this.note ? `<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>${esc(this.note)}</div>` : '';
    if (!c) {
      this.root.hidden = !this.note;
      this.root.className = 'scenario-bar panel compact';
      this.root.innerHTML = note;
      return;
    }
    const w = c.walk;
    const n = w.steps.length;
    const st = w.steps[c.step]!;
    const aside = this.previous
      ? `<button type="button" class="sc-link sc-swap" title="Revenir au scénario laissé de côté">↩ ${esc(this.previous.walk.title)} · étape ${this.previous.step + 1}</button>`
      : '';
    this.root.hidden = false;
    if (this.paused) {
      this.root.className = 'scenario-bar panel compact';
      this.root.innerHTML = `
        <div class="sc-pill">
          <span class="sc-pill-icon" aria-hidden="true">⏸</span>
          <span class="sc-pill-text"><b>${esc(w.title)}</b> · étape ${c.step + 1}/${n}</span>
          <button type="button" class="sc-btn sc-primary sc-resume">Reprendre ▸</button>
          <button type="button" class="sc-icon sc-quit" title="Quitter le scénario" aria-label="Quitter le scénario">✕</button>
        </div>${aside ? `<div class="sc-foot">${aside}</div>` : ''}${note}`;
    } else {
      const who = w.invented ? 'Personnage inventé' : `Personnage réel${w.hero ? ` · ${esc(w.hero.name)}` : ''}`;
      const cast = st.cast.filter((p) => p.qid !== w.hero?.qid).map((p) => p.name);
      this.root.className = 'scenario-bar panel';
      this.root.innerHTML = `
        <div class="sc-head">
          <span class="sc-kicker"><span class="sc-live" aria-hidden="true"></span>Scénario en cours · ${who}</span>
          <button type="button" class="sc-icon sc-pause" title="Mettre en pause (explorer librement)" aria-label="Mettre en pause">⏸</button>
          <button type="button" class="sc-icon sc-quit" title="Quitter le scénario et revenir à la vue d’avant" aria-label="Quitter le scénario">✕</button>
        </div>
        <div class="sc-title">🎭 ${esc(w.title)}</div>
        <div class="sc-premise">${esc(w.premise)}</div>
        <div class="sc-progress" role="group" aria-label="Étapes">${w.steps.map((s, j) =>
          `<button type="button" class="sc-dot${j === c.step ? ' on' : j < c.step ? ' done' : ''}" data-step="${j}" title="${esc(`${j + 1}. ${s.place} · ${formatYear(s.year)}`)}" aria-label="Étape ${j + 1}"></button>`).join('')}</div>
        <div class="sc-step">
          <div class="sc-step-head">Étape ${c.step + 1}/${n} · ${esc(st.place)} · ${esc(formatYear(st.year))}${st.label ? ` <span class="sc-step-label">· ${esc(st.label)}</span>` : ''}</div>
          <p class="sc-step-text">${esc(st.text)}</p>
          ${cast.length ? `<div class="sc-step-cast">Avec ${esc(cast.join(', '))}</div>` : ''}
        </div>
        <div class="sc-actions">
          <button type="button" class="sc-btn sc-prev" ${c.step === 0 ? 'disabled' : ''}>◂ Précédente</button>
          ${c.step + 1 < n
            ? '<button type="button" class="sc-btn sc-primary sc-next">Suivante ▸</button>'
            : '<button type="button" class="sc-btn sc-primary sc-end">Terminer ✓</button>'}
        </div>
        <div class="sc-foot">
          ${w.from ? `<button type="button" class="sc-link sc-card" title="Rouvrir la fiche de ce scénario">Fiche : ${esc(w.from.title)}</button>` : ''}
          ${aside}
          <a class="sc-link sc-source" href="${esc(w.source.url)}" target="_blank" rel="noopener">Imaginé par IA d’après « ${esc(w.source.title.replace(/^Wikipédia : /, ''))} »</a>
        </div>${note}`;
    }
    const on = (sel: string, fn: () => void) => this.root.querySelector(sel)?.addEventListener('click', fn);
    on('.sc-resume', () => this.resume());
    on('.sc-pause', () => this.pause());
    on('.sc-quit', () => this.quit());
    on('.sc-end', () => this.quit());
    on('.sc-prev', () => this.go(-1));
    on('.sc-next', () => this.go(1));
    on('.sc-swap', () => this.swap());
    on('.sc-card', () => this.onOpenCard(w));
    this.root.querySelectorAll<HTMLButtonElement>('.sc-dot').forEach((b) => b.addEventListener('click', () => {
      c.step = Number(b.dataset.step);
      this.show();
    }));
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
}
