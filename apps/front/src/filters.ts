import { Category, CATEGORY_LABELS } from '@way/shared';
import { CATEGORY_COLORS } from './icons.ts';

const ORDER: Category[] = [
  'battle', 'polity', 'city', 'monument', 'religion', 'discovery', 'event',
  'disaster', 'trade', 'science', 'art', 'nature', 'person', 'place',
];

/** Category toggles (display-side in V0; they double as the map legend). */
export class Filters {
  private hidden: Set<Category>;
  private buttons = new Map<Category, HTMLButtonElement>();

  constructor(root: HTMLElement, initialHidden: Category[], private onChange: (hidden: Set<Category>) => void) {
    this.hidden = new Set(initialHidden.filter((c) => Category.safeParse(c).success));
    root.innerHTML = `
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

  private sync(notify = true): void {
    for (const [c, b] of this.buttons) b.setAttribute('aria-pressed', String(!this.hidden.has(c)));
    const toggle = this.buttons.values().next().value?.parentElement?.querySelector('.filters-toggle');
    if (toggle) toggle.textContent = this.hidden.size === 0 ? 'Tout masquer' : 'Tout afficher';
    if (notify) this.onChange(this.hidden);
  }
}
