import { formatYear, type PoiLite, type StoryPerson } from '@way/shared';

// A name to act on, wherever it shows (a ruler, a person of a story, a link
// of a card's text, someone present at a step): one small menu of what can
// be done with it on the globe, its Wikipedia article kept last.

export type Entity =
  | { kind: 'person'; person: StoryPerson; url?: string }
  | { kind: 'card'; poi: PoiLite; url?: string }
  | { kind: 'place'; name: string; lat: number; lon: number; url?: string };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A person's article in French Wikipedia, through Wikidata when no link is known. */
const personUrl = (qid: string) => `https://www.wikidata.org/wiki/Special:GoToLinkedPage/frwiki/${qid}`;

export class EntityMenu {
  private el: HTMLElement;
  private shown: Entity | null = null;
  private anchor: HTMLElement | null = null;

  /** Follow someone on the map (Personnages panel). */
  onFollow: (p: StoryPerson) => void = () => undefined;
  /** The paths through someone, in the carnet. */
  onPersonPaths: (p: StoryPerson) => void = () => undefined;
  /** Someone's life as a path. */
  onLife: (p: StoryPerson) => void = () => undefined;
  onOpenCard: (poi: PoiLite) => void = () => undefined;
  /** The paths through a card, in the carnet. */
  onPlacePaths: (poi: PoiLite) => void = () => undefined;
  onFlyTo: (lat: number, lon: number) => void = () => undefined;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'entity-menu panel';
    this.el.setAttribute('role', 'menu');
    this.el.hidden = true;
    document.body.append(this.el);
    this.el.addEventListener('click', (e) => this.act(e));
    // Anywhere else, or Escape: the menu goes.
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target as Node) && !this.anchor?.contains(e.target as Node)) this.close();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) {
        this.close();
        e.stopPropagation();
      }
    }, true);
    window.addEventListener('resize', () => this.close());
  }

  /** The menu of a name, under it; again on the same name, it closes. */
  show(anchor: HTMLElement, e: Entity): void {
    if (this.anchor === anchor && !this.el.hidden) return this.close();
    this.shown = e;
    this.anchor = anchor;
    const item = (a: string, icon: string, label: string) => `<button type="button" role="menuitem" data-a="${a}"><span aria-hidden="true">${icon}</span>${label}</button>`;
    const title = e.kind === 'person' ? e.person.name : e.kind === 'card' ? e.poi.title : e.name;
    const meta = e.kind === 'person' ? [e.person.role, life(e.person)].filter(Boolean).join(' · ') : e.kind === 'card' ? years(e.poi) : 'Lieu';
    const items = e.kind === 'person'
      ? [item('follow', '👁', 'Suivre sur la carte'), item('person-paths', '🎭', 'Ses chemins'), item('life', '▸', 'Vivre sa vie')]
      : e.kind === 'card'
        ? [item('card', '📄', 'Sa fiche'), item('place-paths', '🎭', 'Ses chemins'), item('fly', '🗺', 'Voir sur la carte')]
        : [item('fly', '🗺', 'Y aller')];
    const url = e.url ?? (e.kind === 'person' ? personUrl(e.person.qid) : null);
    this.el.innerHTML = `
      <div class="entity-head"><b>${esc(title)}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</div>
      ${items.join('')}
      ${url ? `<a role="menuitem" href="${esc(url)}" target="_blank" rel="noopener"><span aria-hidden="true">↗</span>Wikipédia</a>` : ''}`;
    this.el.hidden = false;
    // Under the name, inside the window.
    const r = anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const top = r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.querySelector<HTMLElement>('button, a')?.focus({ preventScroll: true });
  }

  close(): void {
    this.el.hidden = true;
    this.shown = null;
    this.anchor = null;
  }

  private act(ev: MouseEvent): void {
    const b = (ev.target as Element).closest<HTMLElement>('[data-a], a');
    const e = this.shown;
    if (!b || !e) return;
    const a = b.dataset.a;
    this.close();
    if (!a) return;
    if (e.kind === 'person') {
      if (a === 'follow') this.onFollow(e.person);
      else if (a === 'person-paths') this.onPersonPaths(e.person);
      else if (a === 'life') this.onLife(e.person);
    } else if (e.kind === 'card') {
      if (a === 'card') this.onOpenCard(e.poi);
      else if (a === 'place-paths') this.onPlacePaths(e.poi);
      else if (a === 'fly') this.onFlyTo(e.poi.lat, e.poi.lon);
    } else if (a === 'fly') this.onFlyTo(e.lat, e.lon);
  }
}

/**
 * Where the words linked fall in a text: the first time each shows, whole
 * words, never overlapping, in the order of the text. Pure, for tests.
 */
export function placeLinks(text: string, labels: string[]): { i: number; start: number; end: number }[] {
  const out: { i: number; start: number; end: number }[] = [];
  const word = /[\p{L}\p{N}]/u;
  labels.forEach((label, i) => {
    let from = 0;
    for (;;) {
      const start = text.indexOf(label, from);
      if (start < 0) return;
      const end = start + label.length;
      const whole = !word.test(text[start - 1] ?? ' ') && !word.test(text[end] ?? ' ');
      if (whole && !out.some((o) => start < o.end && end > o.start)) {
        out.push({ i, start, end });
        return;
      }
      from = start + 1;
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

function life(p: StoryPerson): string {
  return p.born !== null || p.died !== null ? `${p.born !== null ? formatYear(p.born) : '?'} – ${p.died !== null ? formatYear(p.died) : ''}` : '';
}

function years(p: PoiLite): string {
  return p.date_end !== null && p.date_end !== p.date_start ? `${formatYear(p.date_start)} – ${formatYear(p.date_end)}` : formatYear(p.date_start);
}
