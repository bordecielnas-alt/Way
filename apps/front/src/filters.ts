import { Category, CATEGORY_LABELS } from '@way/shared';
import { CATEGORY_COLORS } from './icons.ts';

const ORDER: Category[] = [
  'battle', 'polity', 'city', 'monument', 'religion', 'discovery', 'event',
  'disaster', 'trade', 'science', 'art', 'nature', 'person', 'place',
];

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

/** Category toggles (they double as the map legend) and the impact scale. */
export class Filters {
  private hidden: Set<Category>;
  private buttons = new Map<Category, HTMLButtonElement>();
  private scaleButtons = new Map<Scale, HTMLButtonElement>();

  constructor(
    root: HTMLElement,
    initialHidden: Category[],
    private onChange: (hidden: Set<Category>) => void,
    public scale: Scale,
    private onScale: (scale: Scale) => void,
  ) {
    this.hidden = new Set(initialHidden.filter((c) => Category.safeParse(c).success));
    root.innerHTML = `
      <div class="filters-head">
        <span class="filters-title">Échelle</span>
      </div>
      <div class="scale" role="group" aria-label="Échelle d’impact">${SCALES.map(
        (s) => `<button type="button" data-scale="${s.value}" title="${s.title}">${s.label}</button>`,
      ).join('')}</div>
      <div class="filters-head">
        <span class="filters-title">Thèmes</span>
        <button class="filters-toggle" type="button">Tout afficher</button>
      </div>`;
    for (const c of ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.innerHTML = `<span class="chip-dot" style="background:${CATEGORY_COLORS[c]}"></span>${CATEGORY_LABELS[c]}<span class="chip-count"></span>`;
      b.addEventListener('click', () => {
        if (this.hidden.has(c)) this.hidden.delete(c);
        else this.hidden.add(c);
        this.sync();
      });
      root.appendChild(b);
      this.buttons.set(c, b);
    }
    root.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
      const v = b.dataset.scale as Scale;
      this.scaleButtons.set(v, b);
      b.addEventListener('click', () => {
        this.scale = v;
        this.syncScale();
        this.onScale(v);
      });
    });
    if (!this.scaleButtons.has(this.scale)) this.scale = 'selection';
    this.syncScale();
    root.querySelector('.filters-toggle')!.addEventListener('click', () => {
      this.hidden = this.hidden.size === 0 ? new Set(ORDER) : new Set();
      this.sync();
    });
    this.sync(false);
  }

  get hiddenSet(): Set<Category> {
    return this.hidden;
  }

  setCounts(counts: Map<Category, number>): void {
    for (const [c, b] of this.buttons) {
      const n = counts.get(c) ?? 0;
      b.querySelector('.chip-count')!.textContent = n ? String(n) : '';
    }
  }

  private syncScale(): void {
    for (const [v, b] of this.scaleButtons) b.setAttribute('aria-pressed', String(v === this.scale));
  }

  private sync(notify = true): void {
    for (const [c, b] of this.buttons) b.setAttribute('aria-pressed', String(!this.hidden.has(c)));
    const toggle = this.buttons.values().next().value?.parentElement?.querySelector('.filters-toggle');
    if (toggle) toggle.textContent = this.hidden.size === 0 ? 'Tout masquer' : 'Tout afficher';
    if (notify) this.onChange(this.hidden);
  }
}
