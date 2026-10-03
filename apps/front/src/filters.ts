import {
  ALL_THEMES, BACKDROP_LABELS, CATEGORY_LABELS, CATEGORY_THEME, FAITH_LABELS, FAITHS, LENSES, makeShown, THEME_CATEGORIES, THEME_LABELS, THEMES,
  themesOf, type Backdrop, type Category, type Lens, type PoiLite, type Theme, type ThemeFilter,
} from '@way/shared';
import { FAITH_COLORS } from './borders.ts';
import { GEOGRAPHY, type Geography } from './geography.ts';
import { CATEGORY_COLORS, PEOPLE_COLOR, THEME_COLORS } from './icons.ts';
import { LIVING, type Living } from './living.ts';

/** Impact scale (brief §4.7): how many minor points show at a given zoom. */
export type Scale = 'major' | 'selection' | 'all';
const SCALES: { value: Scale; label: string; title: string }[] = [
  { value: 'major', label: 'Majeurs', title: 'Seulement les faits majeurs' },
  { value: 'selection', label: 'Sélection', title: 'Les plus notables selon le zoom' },
  { value: 'all', label: 'Tout', title: 'Tous les points connus' },
];

/** Minimum importance shown at a camera height: the higher, the more selective. */
export function importanceFloor(scale: Scale, height: number): number {
  if (scale === 'all') return 0;
  const zoom = Math.min(1, Math.max(0, (Math.log10(height) - 4.7) / (7.3 - 4.7))); // 50 km .. 20 000 km
  const floor = zoom * 0.5;
  // Quantized so camera moves don't resync markers for tiny changes.
  return Math.round((scale === 'major' ? floor + 0.2 : floor) * 20) / 20;
}

/** Coats of arms and flags: faint on the territories, on the armies' banners. */
export interface Heraldry { territories: boolean; armies: boolean }
const HERALDRY: { key: keyof Heraldry; label: string; title: string }[] = [
  { key: 'territories', label: 'Territoires', title: 'Blason ou drapeau en filigrane sur chaque territoire' },
  { key: 'armies', label: 'Armées', title: 'Drapeau et couleurs de leur camp sur les armées' },
];

function lensFilter(l: Lens): ThemeFilter {
  const on = l.themes === 'all' ? THEMES : l.themes;
  return { hiddenThemes: THEMES.filter((t) => !on.includes(t)), hiddenCats: [], people: l.people };
}

/**
 * The left panel: lenses (ready-made views), the backdrop of the territories,
 * the impact scale, the themes (with their finer categories on demand, they
 * double as the map legend), the geography layers and the coats of arms.
 */
export class Filters {
  private themeButtons = new Map<Theme, HTMLButtonElement>();
  private catButtons = new Map<Category, HTMLButtonElement>();
  private lensButtons = new Map<string, HTMLButtonElement>();
  private backdropButtons = new Map<Backdrop, HTMLButtonElement>();
  private scaleButtons = new Map<Scale, HTMLButtonElement>();
  private peopleButton: HTMLButtonElement;
  private toggleAll: HTMLButtonElement;
  private legend: HTMLElement;

  constructor(
    private root: HTMLElement,
    public themes: ThemeFilter,
    private onThemes: (f: ThemeFilter) => void,
    public backdrop: Backdrop,
    private onBackdrop: (b: Backdrop) => void,
    public scale: Scale,
    private onScale: (scale: Scale) => void,
    public heraldry: Heraldry,
    private onHeraldry: (h: Heraldry) => void,
    public geography: Geography,
    private onGeography: (g: Geography) => void,
    detailed: boolean,
    private onDetailed: (on: boolean) => void,
    public living: Living,
    private onLiving: (l: Living) => void,
  ) {
    root.innerHTML = `
      <button type="button" class="filters-fold" aria-expanded="true">
        <span class="filters-title">Filtres</span><span class="fsec-sum"></span><span class="fsec-chev" aria-hidden="true"></span>
      </button>
      <div class="filters-body">
      ${section('lenses', 'Lentilles', `<div class="lenses" role="group" aria-label="Lentilles">${LENSES.map(
        (l) => `<button type="button" data-lens="${l.id}" title="${l.title}">${l.label}</button>`,
      ).join('')}</div>`)}
      ${section('backdrop', 'Territoires',`<div class="scale" role="group" aria-label="Fond des territoires">${(Object.keys(BACKDROP_LABELS) as Backdrop[]).map(
        (b) => `<button type="button" data-backdrop="${b}" title="${BACKDROP_LABELS[b].title}">${BACKDROP_LABELS[b].label}</button>`,
      ).join('')}</div>
      <div class="faith-legend" hidden>${FAITHS.map(
        (f) => `<span class="faith"><span class="chip-dot" style="background:${FAITH_COLORS[f]}"></span>${FAITH_LABELS[f]}</span>`,
      ).join('')}<span class="faith"><span class="chip-dot unknown"></span>Inconnue</span></div>`)}
      ${section('scale', 'Échelle', `<div class="scale" role="group" aria-label="Échelle d’impact">${SCALES.map(
        (s) => `<button type="button" data-scale="${s.value}" title="${s.title}">${s.label}</button>`,
      ).join('')}</div>`)}
      ${section('themes', 'Thèmes', `<div class="themes-tools">
          <button class="filters-toggle filters-detail" type="button" title="Afficher les catégories de chaque thème">Détail</button>
          <button class="filters-toggle filters-all" type="button">Tout afficher</button>
        </div>
        <div class="themes"></div>`)}
      ${section('living', 'Monde vivant', `<div class="geo-chips" role="group" aria-label="Monde vivant">${LIVING.map(
        (g) => `<button type="button" class="chip" data-living="${g.key}" title="${g.title}"><span class="chip-dot" style="background:${g.color}"></span>${g.label}</button>`,
      ).join('')}</div>
      <div class="living-note" hidden></div>`)}
      ${section('geography', 'Géographie', `<div class="geo-chips" role="group" aria-label="Géographie">${GEOGRAPHY.map(
        (g) => `<button type="button" class="chip" data-geo="${g.key}" title="${g.title}"><span class="chip-dot" style="background:${g.color}"></span>${g.label}</button>`,
      ).join('')}</div>`)}
      ${section('heraldry', 'Blasons', `<div class="scale heraldry" role="group" aria-label="Blasons et drapeaux">${HERALDRY.map(
        (h) => `<button type="button" data-heraldry="${h.key}" title="${h.title}">${h.label}</button>`,
      ).join('')}</div>`)}
      </div>`;
    this.bindFolds();

    // ---------- themes, and their categories in detail ----------
    const box = root.querySelector<HTMLElement>('.themes')!;
    box.classList.toggle('detailed', detailed);
    for (const t of THEMES) {
      const b = chip(THEME_COLORS[t], THEME_LABELS[t]);
      b.classList.add('theme-chip');
      b.addEventListener('click', () => this.toggleTheme(t));
      box.appendChild(b);
      this.themeButtons.set(t, b);
      const cats = THEME_CATEGORIES[t];
      if (cats.length < 2) continue;
      const sub = document.createElement('div');
      sub.className = 'subcats';
      for (const c of cats) {
        const cb = chip(CATEGORY_COLORS[c], CATEGORY_LABELS[c]);
        cb.addEventListener('click', () => this.toggleCategory(c));
        sub.appendChild(cb);
        this.catButtons.set(c, cb);
      }
      box.appendChild(sub);
    }
    this.peopleButton = chip(PEOPLE_COLOR, 'Personnages');
    this.peopleButton.classList.add('theme-chip', 'people-chip');
    this.peopleButton.title = 'Rattachés aux thèmes de leurs rôles : un roi au pouvoir, un saint à la religion…';
    this.peopleButton.addEventListener('click', () => this.setThemes({ ...this.themes, people: !this.themes.people }));
    box.appendChild(this.peopleButton);
    root.querySelector('.filters-detail')!.addEventListener('click', () => {
      const on = !box.classList.contains('detailed');
      box.classList.toggle('detailed', on);
      this.onDetailed(on);
    });
    this.toggleAll = root.querySelector('.filters-all')!;
    this.toggleAll.addEventListener('click', () => {
      const allOn = this.themes.hiddenThemes.length === 0 && this.themes.hiddenCats.length === 0 && this.themes.people;
      this.setThemes(allOn ? { hiddenThemes: [...THEMES], hiddenCats: [], people: false } : ALL_THEMES);
    });

    // ---------- lenses ----------
    root.querySelectorAll<HTMLButtonElement>('[data-lens]').forEach((b) => {
      const lens = LENSES.find((l) => l.id === b.dataset.lens)!;
      this.lensButtons.set(lens.id, b);
      b.addEventListener('click', () => {
        this.setBackdrop(lens.backdrop);
        this.setThemes(lensFilter(lens));
      });
    });

    // ---------- backdrop, scale, layers ----------
    this.legend = root.querySelector('.faith-legend')!;
    root.querySelectorAll<HTMLButtonElement>('[data-backdrop]').forEach((b) => {
      const v = b.dataset.backdrop as Backdrop;
      this.backdropButtons.set(v, b);
      b.addEventListener('click', () => this.setBackdrop(v));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
      const v = b.dataset.scale as Scale;
      this.scaleButtons.set(v, b);
      b.addEventListener('click', () => {
        this.scale = v;
        this.syncScale();
        this.onScale(v);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-heraldry]').forEach((b) => {
      const k = b.dataset.heraldry as keyof Heraldry;
      const sync = () => {
        b.setAttribute('aria-pressed', String(this.heraldry[k]));
        this.summarize();
      };
      sync();
      b.addEventListener('click', () => {
        this.heraldry = { ...this.heraldry, [k]: !this.heraldry[k] };
        sync();
        this.onHeraldry(this.heraldry);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-living]').forEach((b) => {
      const k = b.dataset.living as keyof Living;
      const sync = () => {
        b.setAttribute('aria-pressed', String(this.living[k]));
        this.summarize();
      };
      sync();
      b.addEventListener('click', () => {
        this.living = { ...this.living, [k]: !this.living[k] };
        sync();
        this.onLiving(this.living);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-geo]').forEach((b) => {
      const k = b.dataset.geo as keyof Geography;
      const sync = () => {
        b.setAttribute('aria-pressed', String(this.geography[k]));
        this.summarize();
      };
      sync();
      b.addEventListener('click', () => {
        this.geography = { ...this.geography, [k]: !this.geography[k] };
        sync();
        this.onGeography(this.geography);
      });
    });
    if (!this.scaleButtons.has(this.scale)) this.scale = 'selection';
    if (!this.backdropButtons.has(this.backdrop)) this.backdrop = 'political';
    this.syncScale();
    this.syncBackdrop();
    this.syncThemes();
  }

  /** What the Monde vivant layers are doing (an AI reading, no AI), or '' to hide the note. */
  setLivingNote(text: string): void {
    const el = this.root.querySelector<HTMLElement>('.living-note')!;
    el.hidden = !text;
    el.textContent = text;
  }

  get shown(): (p: PoiLite) => boolean {
    return makeShown(this.themes);
  }

  /** Counts among the points of the window: per theme (people counted in their roles' themes), per category. */
  setCounts(pois: PoiLite[]): void {
    const themes = new Map<Theme, number>();
    const cats = new Map<Category, number>();
    let people = 0;
    for (const p of pois) {
      cats.set(p.category, (cats.get(p.category) ?? 0) + 1);
      if (p.category === 'person') people++;
      for (const t of themesOf(p)) themes.set(t, (themes.get(t) ?? 0) + 1);
    }
    const set = (b: HTMLButtonElement, n: number) => (b.querySelector('.chip-count')!.textContent = n ? String(n) : '');
    for (const [t, b] of this.themeButtons) set(b, themes.get(t) ?? 0);
    for (const [c, b] of this.catButtons) set(b, cats.get(c) ?? 0);
    set(this.peopleButton, people);
  }

  /** Folding: the whole panel, and each section (open ones remembered). */
  private bindFolds(): void {
    const open = loadFolds();
    const fold = this.root.querySelector<HTMLButtonElement>('.filters-fold')!;
    const setPanel = (on: boolean) => {
      fold.setAttribute('aria-expanded', String(on));
      this.root.classList.toggle('folded', !on);
    };
    setPanel(open.panel !== false);
    fold.addEventListener('click', () => {
      const on = this.root.classList.contains('folded');
      setPanel(on);
      saveFolds({ ...loadFolds(), panel: on });
    });
    this.root.querySelectorAll<HTMLElement>('.fsec').forEach((sec) => {
      const id = sec.dataset.sec!;
      const head = sec.querySelector<HTMLButtonElement>('.fsec-head')!;
      const set = (on: boolean) => {
        head.setAttribute('aria-expanded', String(on));
        sec.classList.toggle('open', on);
      };
      set(open[id] ?? DEFAULT_OPEN.includes(id));
      head.addEventListener('click', () => {
        const on = !sec.classList.contains('open');
        set(on);
        saveFolds({ ...loadFolds(), [id]: on });
      });
    });
  }

  /** The current choice of each section, written in its header: a folded section still says what it does. */
  private summarize(): void {
    if (!this.legend) return; // still being built
    const sum = (id: string, text: string) => {
      const el = this.root.querySelector<HTMLElement>(`.fsec[data-sec="${id}"] .fsec-sum`);
      if (el) el.textContent = text;
    };
    const lens = LENSES.find((l) => this.lensButtons.get(l.id)?.getAttribute('aria-pressed') === 'true');
    sum('lenses', lens?.label ?? 'Personnalisée');
    sum('backdrop', BACKDROP_LABELS[this.backdrop].label);
    sum('scale', SCALES.find((s) => s.value === this.scale)?.label ?? '');
    const on = THEMES.length - this.themes.hiddenThemes.length;
    const all = on === THEMES.length && this.themes.people && !this.themes.hiddenCats.length;
    sum('themes', all ? 'Tous' : `${on}/${THEMES.length}${this.themes.people ? ' · personnages' : ''}`);
    const count = (n: number) => (n ? `${n} actif${n > 1 ? 's' : ''}` : 'Aucun');
    sum('living', count(LIVING.filter((g) => this.living[g.key]).length));
    sum('geography', count(GEOGRAPHY.filter((g) => this.geography[g.key]).length));
    sum('heraldry', HERALDRY.filter((h) => this.heraldry[h.key]).map((h) => h.label).join(' · ') || 'Aucun');
    // Folded panel: the lens (else the backdrop) recalls the view.
    this.root.querySelector<HTMLElement>('.filters-fold .fsec-sum')!.textContent = lens?.label ?? BACKDROP_LABELS[this.backdrop].label;
  }

  private toggleTheme(t: Theme): void {
    const hidden = new Set(this.themes.hiddenThemes);
    if (hidden.has(t)) {
      hidden.delete(t);
      // Turning a theme back on shows all of it.
      this.setThemes({ ...this.themes, hiddenThemes: [...hidden], hiddenCats: this.themes.hiddenCats.filter((c) => !THEME_CATEGORIES[t].includes(c)) });
    } else this.setThemes({ ...this.themes, hiddenThemes: [...hidden, t] });
  }

  private toggleCategory(c: Category): void {
    const theme = CATEGORY_THEME[c as Exclude<Category, 'person'>];
    const cats = new Set(this.themes.hiddenCats);
    let themes = this.themes.hiddenThemes;
    if (themes.includes(theme)) {
      // From a hidden theme, a category turns on alone.
      themes = themes.filter((t) => t !== theme);
      for (const x of THEME_CATEGORIES[theme]) if (x !== c) cats.add(x);
      cats.delete(c);
    } else if (cats.has(c)) cats.delete(c);
    else cats.add(c);
    // All of a theme's categories off: the theme is off.
    if (THEME_CATEGORIES[theme].every((x) => cats.has(x))) {
      for (const x of THEME_CATEGORIES[theme]) cats.delete(x);
      themes = [...themes, theme];
    }
    this.setThemes({ ...this.themes, hiddenThemes: themes, hiddenCats: [...cats] });
  }

  private setThemes(f: ThemeFilter): void {
    this.themes = f;
    this.syncThemes();
    this.onThemes(f);
  }

  private setBackdrop(b: Backdrop): void {
    if (b === this.backdrop) return;
    this.backdrop = b;
    this.syncBackdrop();
    this.onBackdrop(b);
  }

  private syncScale(): void {
    for (const [v, b] of this.scaleButtons) b.setAttribute('aria-pressed', String(v === this.scale));
    this.summarize();
  }

  private syncBackdrop(): void {
    for (const [v, b] of this.backdropButtons) b.setAttribute('aria-pressed', String(v === this.backdrop));
    this.legend.hidden = this.backdrop !== 'religion';
    this.syncLenses();
  }

  private syncThemes(): void {
    const f = this.themes;
    for (const [t, b] of this.themeButtons) {
      const off = f.hiddenThemes.includes(t);
      const partial = !off && THEME_CATEGORIES[t].some((c) => f.hiddenCats.includes(c));
      b.setAttribute('aria-pressed', String(!off));
      b.classList.toggle('partial', partial);
    }
    for (const [c, b] of this.catButtons) {
      const theme = CATEGORY_THEME[c as Exclude<Category, 'person'>];
      b.setAttribute('aria-pressed', String(!f.hiddenThemes.includes(theme) && !f.hiddenCats.includes(c)));
    }
    this.peopleButton.setAttribute('aria-pressed', String(f.people));
    const allOn = f.hiddenThemes.length === 0 && f.hiddenCats.length === 0 && f.people;
    this.toggleAll.textContent = allOn ? 'Tout masquer' : 'Tout afficher';
    this.syncLenses();
  }

  /** A lens is lit while the filters are exactly its own. */
  private syncLenses(): void {
    const f = this.themes;
    for (const l of LENSES) {
      const want = lensFilter(l);
      const same = l.backdrop === this.backdrop && f.people === want.people && f.hiddenCats.length === 0
        && f.hiddenThemes.length === want.hiddenThemes.length && want.hiddenThemes.every((t) => f.hiddenThemes.includes(t));
      this.lensButtons.get(l.id)!.setAttribute('aria-pressed', String(same));
    }
    this.summarize();
  }
}

/** Sections open the first time: the ready-made views and the themes. */
const DEFAULT_OPEN = ['lenses', 'themes'];
const FOLDS_KEY = 'orbis:filters-open';

function section(id: string, title: string, body: string): string {
  return `<section class="fsec" data-sec="${id}">
    <button type="button" class="fsec-head" aria-expanded="false">
      <span class="filters-title">${title}</span><span class="fsec-sum"></span><span class="fsec-chev" aria-hidden="true"></span>
    </button>
    <div class="fsec-body">${body}</div>
  </section>`;
}

function loadFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveFolds(f: Record<string, boolean>): void {
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(f));
  } catch {
    /* not remembered */
  }
}

function chip(color: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.innerHTML = `<span class="chip-dot" style="background:${color}"></span><span class="chip-label"></span><span class="chip-count"></span>`;
  b.querySelector('.chip-label')!.textContent = label;
  return b;
}
