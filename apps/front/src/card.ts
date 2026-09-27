import {
  CATEGORY_LABELS, DOOR_KINDS, formatPoiDate, formatYear, type Door, type DoorKind, type DoorsResponse, type Poi,
  type PolityInfo, type PolityRulerInfo,
} from '@way/shared';
import { CATEGORY_COLORS } from './icons.ts';
import { fetchCached } from './localcache.ts';

const CONFIDENCE: Record<Poi['confidence'], { icon: string; label: string; title: string }> = {
  verified: { icon: '✓', label: 'Vérifié', title: 'Fait confirmé par Wikidata et Wikipédia' },
  web_single_source: { icon: '🔎', label: 'Source web unique', title: 'Une seule source web, non recoupée' },
  disputed: { icon: '⚠', label: 'Débattu', title: 'Les sources divergent' },
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function coords(lat: number, lon: number): string {
  const f = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'O')}`;
}

function reign(r: PolityRulerInfo): string {
  if (r.start !== null && r.end !== null) return `${formatYear(r.start)} – ${formatYear(r.end)}`;
  if (r.start !== null) return `depuis ${formatYear(r.start)}`;
  return r.end !== null ? `jusqu’en ${formatYear(r.end)}` : '';
}

function rulerEl(r: PolityRulerInfo): string {
  const when = r.when === 'before' ? 'Juste avant : ' : r.when === 'after' ? 'Juste après : ' : '';
  const portrait = r.image
    ? `<img alt="" src="${esc(r.image)}" referrerpolicy="no-referrer">`
    : `<span aria-hidden="true">${esc(r.name.slice(0, 1))}</span>`;
  return `
    <a class="ruler ${r.when}" href="https://www.wikidata.org/wiki/${esc(r.qid)}" target="_blank" rel="noopener">
      <span class="ruler-portrait">${portrait}</span>
      <span class="ruler-text">
        <span class="ruler-name">${when}${esc(r.name)}</span>
        <span class="ruler-meta">${esc([r.office, reign(r)].filter(Boolean).join(' · '))}</span>
      </span>
    </a>`;
}

const DOOR_ICONS: Record<DoorKind, string> = { time: '🕰️', meanwhile: '🌍', next: '🔗', surprise: '❓' };
const DOOR_POLL_MS = 1500;
const DOOR_WAIT_MS = 60_000;

/** Right-hand side panel with the selected point's card. */
export class Card {
  private token = 0;
  /** Door destinations fetched while the current card is read (brief §4.5). */
  private prefetched = new Map<string, Poi>();
  /** POI shown, or null for a territory or a closed panel. */
  private shown: string | null = null;
  /** Territory card: what another click on the map will do. */
  private hint: string | null = null;

  get currentPoi(): string | null {
    return this.root.hidden ? null : this.shown;
  }

  constructor(private root: HTMLElement, private onClose: () => void, private onDoor: (door: Door) => void) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.hidden) this.close();
    });
  }

  async open(id: string): Promise<void> {
    const token = ++this.token;
    this.shown = id;
    this.root.hidden = false;
    document.body.classList.add('card-open');
    const ready = this.prefetched.get(id);
    if (ready) {
      // Counts as a visit and starts the destination's own doors.
      void fetch(`/api/poi/${encodeURIComponent(id)}`);
      this.render(ready, token);
      return;
    }
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll"><div class="card-image skeleton"></div>
        <div class="card-body">
          <div class="skeleton" style="height:14px;width:40%"></div>
          <div class="skeleton" style="height:34px;width:85%;margin-top:14px"></div>
          <div class="skeleton" style="height:16px;width:30%;margin-top:12px"></div>
          ${'<div class="skeleton" style="height:14px;margin-top:10px"></div>'.repeat(5)}
        </div></div>`;
    this.bindClose();
    try {
      const r = await fetch(`/api/poi/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(String(r.status));
      const poi = (await r.json()) as Poi;
      if (token === this.token) this.render(poi, token);
    } catch {
      if (token !== this.token) return;
      this.root.querySelector('.card-body')!.innerHTML =
        '<p class="card-summary-note">Impossible de charger cette fiche pour le moment.</p>';
    }
  }

  /** Card of a territory clicked on the map, at the timeline's year. */
  /**
   * Card of a territory clicked on the map (`name` in the border snapshot),
   * or of a region inside one (`qid` known). Shown from the browser cache at
   * once when possible, then refreshed. Resolves with the card's facts.
   */
  async openPolity(
    target: { name: string } | { qid: string }, shownName: string, year: number, hint: string | null = null,
  ): Promise<PolityInfo | null> {
    const token = ++this.token;
    const region = 'qid' in target;
    this.hint = hint;
    this.shown = null;
    this.root.hidden = false;
    document.body.classList.add('card-open');
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll"><div class="card-body">
        <div class="card-kicker"><span class="card-cat">${region ? 'Région' : 'Territoire'} en ${esc(formatYear(year))}</span></div>
        <h2 class="card-title">${esc(shownName)}</h2>
        <div class="card-summary-note">${region ? 'Recherche de la région' : 'Recherche du royaume'} et de son dirigeant dans Wikidata…</div>
        <div class="skeleton" style="height:56px;margin-top:18px"></div>
        ${'<div class="skeleton" style="height:14px;margin-top:10px"></div>'.repeat(5)}
      </div></div>`;
    this.bindClose();
    const slow = window.setTimeout(() => {
      const note = token === this.token ? this.root.querySelector('.card-summary-note') : null;
      if (note) note.textContent = 'Wikidata est très sollicité et demande de patienter un peu…';
    }, 12_000);
    const params = new URLSearchParams({ ...target, year: String(year) });
    try {
      return await fetchCached<PolityInfo>(`/api/polity?${params}`, (info) => {
        if (token !== this.token) return;
        clearTimeout(slow);
        const scroll = this.root.querySelector('.card-scroll')?.scrollTop ?? 0;
        this.renderPolity(info, shownName, region);
        this.root.querySelector('.card-scroll')!.scrollTop = scroll; // a background refresh does not jump
      });
    } catch {
      if (token === this.token) {
        this.root.querySelector('.card-summary-note')!.textContent = 'Impossible de charger cette fiche pour le moment.';
        this.root.querySelectorAll('.skeleton').forEach((el) => el.remove());
      }
      return null;
    } finally {
      clearTimeout(slow);
    }
  }

  /** Replaces the card's hint line (what another click will do). */
  setHint(text: string | null): void {
    this.hint = text;
    const el = this.root.querySelector<HTMLElement>('.polity-hint');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text ?? '';
  }

  private renderPolity(p: PolityInfo, shownName: string, region: boolean): void {
    const hint = this.hint;
    const span = p.start !== null || p.end !== null
      ? `${p.start !== null ? formatYear(p.start) : '?'} – ${p.end !== null ? formatYear(p.end) : 'aujourd’hui'}`
      : '';
    const facts = [
      ['Capitale', p.capital ? [p.capital] : []],
      ['Régime', p.government],
      ['Religion', p.religion],
      ['Langues', p.languages],
    ].filter(([, v]) => (v as string[]).length > 0) as [string, string[]][];
    const now = p.rulers.filter((r) => r.when === 'now');
    const near = p.rulers.filter((r) => r.when !== 'now');
    const rulers = p.qid
      ? `<div class="card-section">
          <div class="card-section-title">${now.length > 1 ? 'Dirigeants' : 'Dirigeant'} en ${esc(formatYear(p.year))}</div>
          ${now.length ? now.map((r) => rulerEl(r)).join('') : `<p class="card-summary-note">Aucun dirigeant renseigné dans Wikidata pour cette date.</p>`}
          ${near.map((r) => rulerEl(r)).join('')}
        </div>`
      : '';
    const note = p.summaryLang && p.summaryLang !== 'fr' ? '<div class="card-summary-note">Résumé disponible uniquement en anglais.</div>' : '';
    const image = p.image
      ? `<div class="card-image"><img alt="" src="${esc(p.image)}" referrerpolicy="no-referrer"></div>`
      : '';
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll">
        ${image}
        <div class="card-body">
          <div class="card-kicker">
            <span class="card-cat"><i style="background:#b18be0"></i>${esc(p.kind ?? (region ? 'Région' : 'Territoire'))}</span>
          </div>
          <div class="polity-hint" ${hint ? '' : 'hidden'}>${esc(hint ?? '')}</div>
          <div class="polity-head">
            <h2 class="card-title">${esc(p.qid ? p.title : shownName)}</h2>
            ${p.emblem ? `<img class="polity-emblem" alt="" src="${esc(p.emblem)}" referrerpolicy="no-referrer">` : ''}
          </div>
          ${span ? `<div class="card-date">${esc(span)}</div>` : ''}
          ${p.description ? `<div class="card-desc">${esc(p.description)}</div>` : ''}
          ${p.qid ? '' : `<p class="card-summary-note">Pas de fiche trouvée dans Wikidata pour « ${esc(p.name)} ».</p>`}
          ${rulers}
          ${facts.length ? `<dl class="polity-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v.join(', '))}</dd>`).join('')}</dl>` : ''}
          ${p.summary ? `<p class="card-summary">${esc(p.summary)}</p>${note}` : ''}
          <div class="card-section">
            <div class="card-section-title">Sources</div>
            <ul class="card-sources">${p.sources
              .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`)
              .join('')}
              <li><a href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noopener">Frontières : historical-basemaps</a></li></ul>
            <div class="card-summary-note">${region
              ? 'Limites de la région estimées : le territoire est partagé entre les chefs-lieux connus de Wikidata, chaque lieu revenant au plus proche.'
              : `Frontières approximatives.${p.qid ? ` Le territoire « ${esc(p.name)} » de la carte est relié à Wikidata automatiquement : vérifiez les sources.` : ''}`}</div>
          </div>
        </div>
      </div>`;
    this.bindClose();
    this.root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => (img.closest('.card-image') ?? img).remove());
    });
    this.root.querySelector('.card-scroll')!.scrollTop = 0;
  }

  close(): void {
    this.token++;
    this.root.hidden = true;
    document.body.classList.remove('card-open');
    this.onClose();
  }

  private bindClose(): void {
    this.root.querySelector('.card-close')!.addEventListener('click', () => this.close());
  }

  private render(p: Poi, token: number): void {
    const conf = CONFIDENCE[p.confidence];
    // Say where the text comes from whenever it is not a French Wikipedia intro.
    const note =
      p.provenance === 'web_ai'
        ? 'Fiche rédigée par IA à partir des sources ci-dessous : vérifiez-les.'
        : p.tags.includes('summary:ai-translated')
          ? 'Résumé traduit de l’anglais par IA.'
          : p.summary_lang && p.summary_lang !== 'fr'
            ? 'Résumé disponible uniquement en anglais.'
            : null;
    const summary = p.summary
      ? `<p class="card-summary">${esc(p.summary)}</p>${note ? `<div class="card-summary-note">${note}</div>` : ''}`
      : '<div class="card-summary-note">Aucun résumé disponible : consultez les sources.</div>';
    const image = p.image_url
      ? `<div class="card-image"><img alt="" src="${esc(p.image_url)}" referrerpolicy="no-referrer">
           <a class="card-image-credit" href="${esc(p.image_url.split('?')[0]!)}" target="_blank" rel="noopener">Image : Wikimedia Commons</a></div>`
      : '';
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll">
        ${image}
        <div class="card-body">
          <div class="card-kicker">
            <span class="card-cat"><i style="background:${CATEGORY_COLORS[p.category]}"></i>${CATEGORY_LABELS[p.category]}</span>
            <span class="badge ${p.confidence}" title="${conf.title}">${conf.icon} ${conf.label}</span>
          </div>
          <h2 class="card-title">${esc(p.title)}</h2>
          <div class="card-date">${formatPoiDate(p.date_start, p.date_end, p.date_precision)}</div>
          ${p.description ? `<div class="card-desc">${esc(p.description)}</div>` : ''}
          ${summary}
          <div class="card-section doors" hidden>
            <div class="card-section-title">Continuer l’exploration</div>
            <div class="door-list"></div>
          </div>
          <div class="card-section">
            <div class="card-section-title">Sources</div>
            <ul class="card-sources">${p.sources
              .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`)
              .join('')}</ul>
          </div>
          <div class="card-section">
            <div class="card-section-title">Lieu</div>
            <div class="card-coords">${coords(p.lat, p.lon)}</div>
          </div>
        </div>
      </div>`;
    this.bindClose();
    const img = this.root.querySelector<HTMLImageElement>('.card-image img');
    if (img) {
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => img.parentElement?.remove());
    }
    this.root.querySelector('.card-scroll')!.scrollTop = 0;
    void this.loadDoors(p.id, token);
  }

  /** Doors arrive progressively: poll until every kind is known. */
  private async loadDoors(id: string, token: number): Promise<void> {
    const section = this.root.querySelector<HTMLElement>('.doors')!;
    const list = section.querySelector<HTMLElement>('.door-list')!;
    const shown = new Set<DoorKind>();
    const started = performance.now();
    section.hidden = false;
    list.innerHTML = DOOR_KINDS.map((k) => `<div class="door skeleton" data-kind="${k}"></div>`).join('');
    for (;;) {
      let res: DoorsResponse;
      try {
        const r = await fetch(`/api/poi/${encodeURIComponent(id)}/doors`);
        if (!r.ok) throw new Error(String(r.status));
        res = (await r.json()) as DoorsResponse;
      } catch {
        res = { doors: [], pending: [] };
      }
      if (token !== this.token) return;
      for (const d of res.doors) {
        if (shown.has(d.kind)) continue;
        shown.add(d.kind);
        list.querySelector(`[data-kind="${d.kind}"]`)?.replaceWith(this.doorEl(d));
        this.prefetch(d);
      }
      const timedOut = performance.now() - started > DOOR_WAIT_MS;
      if (res.pending.length === 0 || timedOut) {
        list.querySelectorAll('.door.skeleton').forEach((el) => el.remove());
        if (shown.size === 0) section.hidden = true;
        return;
      }
      await new Promise((r) => setTimeout(r, DOOR_POLL_MS));
    }
  }

  private doorEl(d: Door): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'door';
    el.dataset.kind = d.kind;
    el.innerHTML = `
      <span class="door-icon" aria-hidden="true">${DOOR_ICONS[d.kind]}</span>
      <span class="door-text">
        <span class="door-title">${esc(d.title)}</span>
        <span class="door-dest">${esc(d.poi.title)}</span>
        <span class="door-meta">${esc(formatPoiDate(d.poi.date_start, d.poi.date_end, d.poi.date_precision))} · ${esc(d.hint)}</span>
      </span>`;
    el.addEventListener('click', () => this.onDoor(d));
    return el;
  }

  /** Loads the destination's card (and warms its summary and image) before the click. */
  private prefetch(d: Door): void {
    if (this.prefetched.has(d.poi.id)) return;
    void fetch(`/api/poi/${encodeURIComponent(d.poi.id)}?prefetch=1`)
      .then((r) => (r.ok ? (r.json() as Promise<Poi>) : null))
      .then((poi) => {
        if (!poi) return;
        if (this.prefetched.size > 40) this.prefetched.delete(this.prefetched.keys().next().value!);
        this.prefetched.set(poi.id, poi);
        if (poi.image_url) new Image().src = poi.image_url;
      })
      .catch(() => {});
  }
}
