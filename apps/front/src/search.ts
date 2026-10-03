import { CATEGORY_LABELS, formatPoiDate, formatYear, type PersonHit, type PoiLite, type ScenarioWalk } from '@way/shared';
import { CATEGORY_COLORS } from './icons.ts';
import { viaServer } from './media.ts';

// The search bar: events and places (cards), people, countries and
// territories of the period shown, and scenarios already met. A real
// person can also be followed as a scenario across the cards of their life.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const DEBOUNCE_MS = 320;

/** A territory of the period shown, by its name on the map. */
export interface TerritoryHit {
  key: string;
  label: string;
}

export interface SearchSources {
  territories: (q: string) => TerritoryHit[];
  scenarios: (q: string) => ScenarioWalk[];
  /** Scenarios turned on: people can be followed as a scenario. */
  scenariosOn: () => boolean;
}

export interface SearchActions {
  card: (p: PoiLite) => void;
  person: (h: PersonHit) => void;
  personScenario: (h: PersonHit) => void;
  territory: (t: TerritoryHit) => void;
  scenario: (w: ScenarioWalk) => void;
}

type Pick = () => void;

export class SearchBox {
  private input: HTMLInputElement;
  private results: HTMLElement;
  private timer: number | undefined;
  private token = 0;
  private picks: Pick[] = [];
  private active = -1;

  constructor(private root: HTMLElement, private sources: SearchSources, private actions: SearchActions) {
    root.innerHTML = `
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" class="search-input" placeholder="Chercher un événement, un personnage, un pays…" aria-label="Rechercher" autocomplete="off" spellcheck="false">
        <button type="button" class="search-clear" aria-label="Effacer" hidden>×</button>
      </div>
      <div class="search-results" role="listbox" hidden></div>`;
    this.input = root.querySelector('.search-input')!;
    this.results = root.querySelector('.search-results')!;
    const clear = root.querySelector<HTMLButtonElement>('.search-clear')!;
    this.input.addEventListener('input', () => {
      clear.hidden = !this.input.value;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), DEBOUNCE_MS);
    });
    this.input.addEventListener('focus', () => {
      if (this.results.innerHTML && this.input.value.trim().length >= 2) this.results.hidden = false;
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.results.hidden) this.input.blur();
        this.close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(this.timer);
        const pick = this.picks[Math.max(0, this.active)];
        if (pick) pick();
        else void this.run();
      }
      // Arrows and Backspace stay in the field: the timeline and the card listen to the page.
      e.stopPropagation();
    });
    clear.addEventListener('click', () => {
      this.input.value = '';
      clear.hidden = true;
      this.close();
      this.input.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target as Node)) this.results.hidden = true;
    });
  }

  private close(): void {
    this.token++;
    this.results.hidden = true;
  }

  private move(delta: number): void {
    const rows = [...this.results.querySelectorAll<HTMLElement>('.sr-row')];
    if (!rows.length) return;
    this.active = (this.active + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('active', i === this.active));
    rows[this.active]!.scrollIntoView({ block: 'nearest' });
  }

  private async run(): Promise<void> {
    const q = this.input.value.trim();
    const token = ++this.token;
    if (q.length < 2) {
      this.results.hidden = true;
      return;
    }
    // What is known here answers at once; cards and people follow.
    const local = { territories: this.sources.territories(q), scenarios: this.sources.scenarios(q) };
    this.render(local, null, null);
    const get = async <T>(url: string, pick: (v: unknown) => T): Promise<T | 'error'> => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        return pick(await r.json());
      } catch {
        return 'error';
      }
    };
    let cards: PoiLite[] | 'error' | null = null;
    let people: PersonHit[] | 'error' | null = null;
    const show = () => token === this.token && this.render(local, cards, people);
    await Promise.all([
      get(`/api/search?${new URLSearchParams({ q })}`, (v) => (v as { pois: PoiLite[] }).pois).then((v) => { cards = v; show(); }),
      get(`/api/people/search?${new URLSearchParams({ q })}`, (v) => (v as PersonHit[]).slice(0, 5)).then((v) => { people = v; show(); }),
    ]);
  }

  private render(
    local: { territories: TerritoryHit[]; scenarios: ScenarioWalk[] },
    cards: PoiLite[] | 'error' | null, people: PersonHit[] | 'error' | null,
  ): void {
    this.picks = [];
    this.active = -1;
    const row = (html: string, pick: Pick, extra = '') => {
      this.picks.push(pick);
      return `<div class="sr-line"><button type="button" class="sr-row" data-i="${this.picks.length - 1}" role="option">${html}</button>${extra}</div>`;
    };
    const group = (title: string, body: string) => `<div class="sr-group"><div class="sr-title">${title}</div>${body}</div>`;
    const wait = '<div class="sr-empty">Recherche…</div>';
    const failed = '<div class="sr-empty">Wikidata ne répond pas pour le moment.</div>';
    const none = '<div class="sr-empty">Aucun résultat.</div>';
    const scenariosOn = this.sources.scenariosOn();
    const personActs: Pick[] = [];

    const parts: string[] = [];
    if (scenariosOn && local.scenarios.length) {
      parts.push(group('Scénarios', local.scenarios.map((w) => row(`
        <span class="sr-mark sr-mask" aria-hidden="true">🎭</span>
        <span class="sr-text"><b>${esc(w.title)}</b><small>${esc([w.hero?.name ?? (w.invented ? 'Personnage inventé' : ''), w.from?.title ?? 'À travers plusieurs fiches', `${w.steps.length} étapes`].filter(Boolean).join(' · '))}</small></span>`,
      () => this.choose(() => this.actions.scenario(w)))).join('')));
    }
    parts.push(group('Événements et lieux', cards === null ? wait : cards === 'error' ? failed : !cards.length ? none : cards.map((p) => row(`
        <span class="sr-mark" aria-hidden="true"><i style="background:${CATEGORY_COLORS[p.category]}"></i></span>
        <span class="sr-text"><b>${esc(p.title)}</b><small>${esc(`${formatPoiDate(p.date_start, p.date_end, p.date_precision)} · ${CATEGORY_LABELS[p.category]}`)}</small></span>`,
      () => this.choose(() => this.actions.card(p)))).join('')));
    parts.push(group('Personnages', people === null ? wait : people === 'error' ? failed : !people.length ? none : people.map((h) => {
      const life = h.born !== null || h.died !== null ? `${h.born !== null ? formatYear(Math.floor(h.born)) : '?'} – ${h.died !== null ? formatYear(Math.floor(h.died)) : ''}` : '';
      personActs.push(() => this.choose(() => this.actions.personScenario(h)));
      const story = scenariosOn
        ? `<button type="button" class="sr-act" data-act="${personActs.length - 1}" title="Un scénario à travers les fiches de sa vie, écrit par l’IA">🎭 Vivre son histoire</button>`
        : '';
      return row(`
        <span class="sr-mark">${h.image ? `<img alt="" src="${esc(viaServer(h.image))}" referrerpolicy="no-referrer">` : esc(h.name.charAt(0))}</span>
        <span class="sr-text"><b>${esc(h.name)}</b><small>${esc([life, h.description ?? ''].filter(Boolean).join(' · '))}</small></span>`,
      () => this.choose(() => this.actions.person(h)), story);
    }).join('')));
    if (local.territories.length) {
      parts.push(group('Pays et territoires à cette époque', local.territories.map((t) => row(`
        <span class="sr-mark sr-realm" aria-hidden="true"></span>
        <span class="sr-text"><b>${esc(t.label)}</b><small>Sur la carte en ce moment</small></span>`,
      () => this.choose(() => this.actions.territory(t)))).join('')));
    }
    this.results.innerHTML = parts.join('');
    this.results.hidden = false;
    this.results.querySelectorAll<HTMLButtonElement>('.sr-row').forEach((b) => b.addEventListener('click', () => this.picks[Number(b.dataset.i)]!()));
    this.results.querySelectorAll<HTMLButtonElement>('.sr-act').forEach((b) => b.addEventListener('click', () => personActs[Number(b.dataset.act)]!()));
    this.results.querySelectorAll<HTMLImageElement>('img').forEach((img) => img.addEventListener('error', () => img.remove()));
  }

  private choose(run: () => void): void {
    this.results.hidden = true;
    this.input.blur();
    run();
  }
}
