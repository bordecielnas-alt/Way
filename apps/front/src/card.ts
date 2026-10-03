import {
  ACTIVITY_LABELS, CATEGORY_LABELS, DOOR_KINDS, type Army, type JourneyStop, type PersonJourney, formatPoiDate, formatYear, type Door, type DoorKind, type DoorsResponse, type Poi,
  type PoiLite, type PolityInfo, type PolityRulerInfo, toLite, FLOW_LABELS, type CityRow, type Flow, type FlowDef, type FlowStage,
  STORY_PHASES, STORY_PHASE_LABELS, type Story, type StoryPerson, type StoryResponse, type StoryStop,
  THEMES, walkOf, type ScenarioContext, type ScenariosResponse, type ScenarioWalk,
} from '@way/shared';
import { setActivity } from './activity.ts';
import { CATEGORY_COLORS } from './icons.ts';
import { fetchCached } from './localcache.ts';
import { formatPop } from './living.ts';
import { viaServer } from './media.ts';

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
    ? `<img alt="" src="${esc(viaServer(r.image))}" referrerpolicy="no-referrer">`
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

const DOOR_ICONS: Record<DoorKind, string> = { cause: '⏪', effect: '⏩', meanwhile: '🌍', time: '🕰️', surprise: '❓' };
/** Cards kept in the trail of the walk. */
const TRAIL_MAX = 12;
const DOOR_POLL_MS = 1500;
const DOOR_WAIT_MS = 60_000;
const STORY_POLL_MS = 3000;
const STORY_WAIT_MS = 150_000;

/** A card's own scenarios, for the carnet: `pending` while an AI writes them. */
export interface CardPaths {
  poi: PoiLite;
  walks: ScenarioWalk[];
  status: 'ready' | 'pending' | 'none' | 'no-ai';
}

/** Right-hand side panel with the selected point's card. */
/** A realm of the map, a member drawn inside it (real borders), or a region whose limits are estimated. */
export type PolityKind = 'territory' | 'member' | 'estimated';

export class Card {
  private token = 0;
  /** Door destinations fetched while the current card is read (brief §4.5). */
  private prefetched = new Map<string, Poi>();
  /** POI shown, or null for a territory or a closed panel. */
  private shown: string | null = null;
  /** Territory card: what another click on the map will do. */
  private hint: string | null = null;
  /** The walk so far: the points whose cards were read, oldest first (the current one last). */
  private trail: PoiLite[] = [];

  /** A stop of a card's story: the map and the timeline go there; `openCard`: its own card too, when it has one. */
  onStoryStop: (s: StoryStop, openCard: boolean) => void = () => undefined;
  /** A person of a card's story: followed on the map (Personnages panel). */
  onStoryPerson: (p: StoryPerson) => void = () => undefined;
  /** How the visitor looks at the world now (the walk so far is added by the card). */
  scenarioContext: () => Omit<ScenarioContext, 'trail'> = () => ({ lens: null, themes: [...THEMES], people: true });
  /** The chip "N chemins passent ici" clicked: the carnet opens on them. */
  onPaths: (at: CardPaths) => void = () => undefined;
  /** The card's own scenarios written or changed (the carnet may be showing them; the search bar remembers them). */
  onPathsChanged: (at: CardPaths) => void = () => undefined;
  /** The paths of a person followed (their card's chip). */
  onPersonPaths: (p: StoryPerson) => void = () => undefined;
  /** Other paths known through a card (met elsewhere): counted on its chip. */
  pathsThrough: (poi: PoiLite) => ScenarioWalk[] = () => [];
  /** Scenarios turned off in the filters: none asked for, none shown. */
  private scenariosOn = true;
  /** The story shown on the current card, and its scenarios as walks. */
  private story: { id: string; token: number; story: Story; from: PoiLite } | null = null;
  private walks: ScenarioWalk[] = [];
  private pathsStatus: CardPaths['status'] = 'none';
  private shownLite: PoiLite | null = null;
  private scenarioToken = 0;
  /** The path played, to mark the chip when it passes here. */
  private playing: ScenarioWalk | null = null;

  get currentPoi(): string | null {
    return this.root.hidden ? null : this.shown;
  }

  /** `onTravel`: go to a point (through a door, or back along the trail). */
  constructor(private root: HTMLElement, private onClose: () => void, private onTravel: (p: PoiLite) => void) {
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') this.close();
      // Backspace walks back the trail, like a browser.
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
      if (e.key === 'Backspace' && !typing && this.shown && this.trail.length > 1) {
        e.preventDefault();
        this.onTravel(this.trail[this.trail.length - 2]!);
      }
    });
  }

  /** A card read: the trail grows, or goes back to it if it was already on the way. */
  private remember(p: Poi): void {
    const i = this.trail.findIndex((x) => x.id === p.id);
    if (i >= 0) this.trail = this.trail.slice(0, i + 1);
    else this.trail = [...this.trail, toLite(p)].slice(-TRAIL_MAX);
  }

  private trailEl(): string {
    if (this.trail.length < 2) return '';
    const past = this.trail.slice(0, -1);
    return `<nav class="trail" aria-label="Chemin parcouru">
      <span class="trail-label">Chemin</span>
      ${past.map((p, i) => `<button type="button" class="trail-step" data-i="${i}" title="${esc(formatPoiDate(p.date_start, p.date_end, p.date_precision))}">${esc(p.title)}</button><span class="trail-sep" aria-hidden="true">›</span>`).join('')}
      <span class="trail-here">${esc(this.trail[this.trail.length - 1]!.title)}</span>
      <button type="button" class="trail-clear" title="Oublier ce chemin" aria-label="Oublier ce chemin">×</button>
    </nav>`;
  }

  private bindTrail(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.trail-step').forEach((b) =>
      b.addEventListener('click', () => this.onTravel(this.trail[Number(b.dataset.i)]!)),
    );
    this.root.querySelector('.trail-clear')?.addEventListener('click', () => {
      this.trail = this.trail.slice(-1);
      this.root.querySelector('.trail')?.remove();
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
    target: { name: string } | { qid: string; name?: string }, shownName: string, year: number, hint: string | null = null,
    kind: PolityKind = 'qid' in target ? 'estimated' : 'territory',
  ): Promise<PolityInfo | null> {
    const token = ++this.token;
    const region = kind !== 'territory';
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
        this.renderPolity(info, shownName, kind);
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

  /**
   * Card of someone followed on the map: what they are doing now, and their
   * life as dated places; a moment clicked takes the map there.
   */
  openPerson(j: PersonJourney, now: string, onStop: (s: JourneyStop) => void): void {
    this.token++;
    this.shown = null;
    this.root.hidden = false;
    document.body.classList.add('card-open');
    const years = (s: JourneyStop) =>
      s.end !== null && Math.floor(s.end) !== Math.floor(s.start)
        ? `${formatYear(Math.floor(s.start))} – ${formatYear(Math.floor(s.end))}`
        : formatYear(Math.floor(s.start));
    const life = j.born !== null || j.died !== null
      ? `${j.born !== null ? formatYear(Math.floor(j.born)) : '?'} – ${j.died !== null ? formatYear(Math.floor(j.died)) : ''}`
      : '';
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll">
        ${j.image ? `<div class="card-image"><img alt="" src="${esc(viaServer(j.image))}" referrerpolicy="no-referrer"></div>` : ''}
        <div class="card-body">
          <div class="card-kicker"><span class="card-cat"><i style="background:#e377c2"></i>Personnage suivi</span></div>
          <h2 class="card-title">${esc(j.name)}</h2>
          ${life ? `<div class="card-date">${esc(life)}</div>` : ''}
          ${j.description ? `<div class="card-desc">${esc(j.description)}</div>` : ''}
          <div class="polity-hint">${esc(now)}</div>
          ${this.scenariosOn ? `<div class="card-paths"><button type="button" class="paths-chip person-paths" title="Ouvrir le carnet de route : les chemins de ce personnage">
            <span class="paths-mask" aria-hidden="true">🎭</span><span class="paths-label"><b>Ses chemins</b> : vivre son histoire</span><span class="paths-go" aria-hidden="true">›</span>
          </button></div>` : ''}
          <div class="card-section">
            <div class="card-section-title">Parcours</div>
            <ol class="journey">${j.stops.map((s, i) => `
              <li><button type="button" data-i="${i}" ${s.lat === null ? 'class="unplaced"' : ''}>
                <span class="journey-when">${esc(years(s))}</span>
                <span class="journey-what"><b>${esc(ACTIVITY_LABELS[s.kind])}</b> ${esc(s.label)}</span>
              </button></li>`).join('')}</ol>
            <div class="card-summary-note">Lieux et dates de Wikidata. Entre deux lieux connus, le trajet est supposé en ligne droite, au rythme d’un voyageur de l’époque. Les moments sans lieu (en gris) ne déplacent pas le personnage.</div>
          </div>
          <div class="card-section">
            <div class="card-section-title">Sources</div>
            <ul class="card-sources"><li><a href="https://www.wikidata.org/wiki/${esc(j.qid)}" target="_blank" rel="noopener">Wikidata : ${esc(j.name)}</a></li></ul>
          </div>
        </div>
      </div>`;
    this.bindClose();
    const year = (y: number | null) => (y === null ? null : Math.floor(y));
    this.root.querySelector('.person-paths')?.addEventListener('click', () =>
      this.onPersonPaths({ qid: j.qid, name: j.name, role: j.description ?? '', born: year(j.born), died: year(j.died), image: j.image }));
    this.root.querySelectorAll<HTMLButtonElement>('.journey button').forEach((b) =>
      b.addEventListener('click', () => onStop(j.stops[Number(b.dataset.i)]!)),
    );
    this.root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => (img.closest('.card-image') ?? img).remove());
    });
  }

  /** Card of an army: its war, side and battles in order. */
  openArmy(a: Army, now: string, onBattle: (b: Army['battles'][number]) => void): void {
    this.token++;
    this.shown = null;
    this.root.hidden = false;
    document.body.classList.add('card-open');
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll"><div class="card-body">
        <div class="card-kicker"><span class="card-cat"><i style="background:#c8554f"></i>Armée en campagne</span></div>
        <h2 class="card-title">${esc(a.side)}</h2>
        <div class="card-desc">${esc(a.war)}</div>
        <div class="polity-hint">${esc(now)}</div>
        <div class="card-section">
          <div class="card-section-title">Batailles</div>
          <ol class="journey">${a.battles.map((b, i) => `
            <li><button type="button" data-i="${i}">
              <span class="journey-when">${esc(formatYear(Math.floor(b.t)))}</span>
              <span class="journey-what"><b>${esc(b.label)}</b>${b.commanders.length ? ` ${esc(b.commanders.join(', '))}` : ''}</span>
            </button></li>`).join('')}</ol>
          <div class="card-summary-note">Batailles de cette guerre où ce camp est cité dans Wikidata, reliées dans l’ordre : la marche entre deux batailles est supposée en ligne droite.</div>
        </div>
        <div class="card-section">
          <div class="card-section-title">Sources</div>
          <ul class="card-sources"><li><a href="https://www.wikidata.org/wiki/${esc(a.warQid)}" target="_blank" rel="noopener">Wikidata : ${esc(a.war)}</a></li></ul>
        </div>
      </div></div>`;
    this.bindClose();
    this.root.querySelectorAll<HTMLButtonElement>('.journey button').forEach((b) =>
      b.addEventListener('click', () => onBattle(a.battles[Number(b.dataset.i)]!)),
    );
  }

  /** Card of a city of the Villes layer: its population at the moment, and the figures it comes from. */
  openCity(c: CityRow, pop: number, sure: number, year: number): void {
    this.token++;
    this.shown = null;
    this.root.hidden = false;
    document.body.classList.add('card-open');
    const [name, country, , , certainty, series] = c;
    const figures: [number, number][] = [];
    for (let i = 0; i < series.length; i += 2) figures.push([series[i]!, series[i + 1]!]);
    const max = Math.max(...figures.map(([, v]) => v));
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll"><div class="card-body">
        <div class="card-kicker"><span class="card-cat"><i style="background:#efe4cc"></i>Ville</span></div>
        <h2 class="card-title">${esc(name)}</h2>
        <div class="card-desc">${esc(country)}</div>
        <div class="card-date">${esc(formatPop(pop))} habitants en ${esc(formatYear(Math.floor(year)))}</div>
        <div class="card-summary-note">${sure < 1 ? 'Estimation incertaine : chiffre repris du plus proche, ou interpolé entre deux chiffres éloignés de plusieurs siècles. ' : ''}${certainty > 1 ? 'Emplacement incertain dans la source.' : ''}</div>
        <div class="card-section">
          <div class="card-section-title">Population estimée</div>
          <ol class="city-figures">${figures.map(([y, v]) => `
            <li><span class="journey-when">${esc(formatYear(y))}</span><span class="city-bar" style="width:${Math.max(2, Math.round((100 * Math.log10(v)) / Math.log10(max)))}%"></span><span class="city-pop">${esc(formatPop(v))}</span></li>`).join('')}</ol>
          <div class="card-summary-note">Entre deux chiffres, la population est interpolée. Les estimations anciennes sont des ordres de grandeur.</div>
        </div>
        <div class="card-section">
          <div class="card-section-title">Sources</div>
          <ul class="card-sources">
            <li><a href="https://doi.org/10.1038/sdata.2016.34" target="_blank" rel="noopener">Reba, Reitsma et Seto (2016), 6 000 ans d’urbanisation (Chandler, Modelski), CC BY 4.0</a></li>
          </ul>
        </div>
      </div></div>`;
    this.bindClose();
  }

  /** Card of a flow (trade route, epidemic, diffusion): its places in order; one clicked takes the map there. */
  openFlow(def: FlowDef, flow: Flow, stage: number, onStage: (s: FlowStage) => void): void {
    this.token++;
    this.shown = null;
    this.root.hidden = false;
    document.body.classList.add('card-open');
    const here = flow.stages[stage];
    const span = def.start === def.end ? formatYear(def.start) : `${formatYear(def.start)} – ${formatYear(def.end)}`;
    const color = { trade: '#d9a441', epidemic: '#d9534f', diffusion: '#7fb3e0' }[def.kind];
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll"><div class="card-body">
        <div class="card-kicker">
          <span class="card-cat"><i style="background:${color}"></i>${esc(FLOW_LABELS[def.kind].label)}</span>
          <span class="badge web_single_source" title="Étapes lues par une IA dans l’article cité, puis placées sur la carte">🔎 Lu par IA</span>
        </div>
        <h2 class="card-title">${esc(def.title)}</h2>
        <div class="card-date">${esc(span)}</div>
        ${here ? `<div class="polity-hint">${esc(here.place)}, ${esc(formatYear(here.year))} : ${esc(here.note)}</div>` : ''}
        <div class="card-section">
          <div class="card-section-title">Étapes</div>
          <ol class="journey">${flow.stages.map((s, i) => `
            <li><button type="button" data-i="${i}" ${i === stage ? 'aria-current="true"' : ''}>
              <span class="journey-when">${esc(formatYear(s.year))}</span>
              <span class="journey-what"><b>${esc(s.place)}</b> ${esc(s.note)}${s.from !== null ? ` <small>depuis ${esc(flow.stages[s.from]!.place)}</small>` : ''}</span>
            </button></li>`).join('')}</ol>
          <div class="card-summary-note">Lieux et dates lus par une IA dans l’article ci-dessous (chaque étape y est citée), placés sur la carte par géocodage : vérifiez-les. Entre deux étapes, le trajet est tracé au plus court${def.kind === 'trade' ? ', par la mer quand il le faut' : ''}.</div>
        </div>
        <div class="card-section">
          <div class="card-section-title">Sources</div>
          <ul class="card-sources"><li><a href="${esc(flow.source.url)}" target="_blank" rel="noopener">${esc(flow.source.title)}</a></li></ul>
        </div>
      </div></div>`;
    this.bindClose();
    this.root.querySelectorAll<HTMLButtonElement>('.journey button').forEach((b) =>
      b.addEventListener('click', () => onStage(flow.stages[Number(b.dataset.i)]!)),
    );
  }

  /** Replaces the card's hint line (what another click will do). */
  setHint(text: string | null): void {
    this.hint = text;
    const el = this.root.querySelector<HTMLElement>('.polity-hint');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text ?? '';
  }

  private renderPolity(p: PolityInfo, shownName: string, kind: PolityKind): void {
    const region = kind !== 'territory';
    const hint = this.hint;
    const yearly = p.year >= -3400;
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
      ? `<div class="card-image"><img alt="" src="${esc(viaServer(p.image))}" referrerpolicy="no-referrer"></div>`
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
            ${p.emblem ? `<img class="polity-emblem" alt="" src="${esc(viaServer(p.emblem))}" referrerpolicy="no-referrer">` : ''}
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
              ${yearly
                ? '<li><a href="https://github.com/Seshat-Global-History-Databank/cliopatria" target="_blank" rel="noopener">Frontières : Cliopatria (Seshat, CC BY 4.0)</a></li>'
                : '<li><a href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noopener">Frontières : historical-basemaps</a></li>'}</ul>
            <div class="card-summary-note">${kind === 'estimated'
              ? 'Limites de la région estimées : le territoire est partagé entre les chefs-lieux connus de Wikidata, chaque lieu revenant au plus proche.'
              : yearly
                ? 'Frontières historiques datées à l’année près, simplifiées au kilomètre.'
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
    this.story = null;
    this.walks = [];
    this.pathsStatus = 'none';
    this.shownLite = toLite(p);
    this.remember(p);
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
      ? `<div class="card-image"><img alt="" src="${esc(viaServer(p.image_url))}" referrerpolicy="no-referrer">
           <a class="card-image-credit" href="${esc(p.image_url.split('?')[0]!)}" target="_blank" rel="noopener">Image : Wikimedia Commons</a></div>`
      : '';
    this.root.innerHTML = `
      <button class="card-close" type="button" aria-label="Fermer">×</button>
      <div class="card-scroll">
        ${image}
        <div class="card-body">
          ${this.trailEl()}
          <div class="card-kicker">
            <span class="card-cat"><i style="background:${CATEGORY_COLORS[p.category]}"></i>${CATEGORY_LABELS[p.category]}</span>
            <span class="badge ${p.confidence}" title="${conf.title}">${conf.icon} ${conf.label}</span>
          </div>
          <h2 class="card-title">${esc(p.title)}</h2>
          <div class="card-date">${formatPoiDate(p.date_start, p.date_end, p.date_precision)}</div>
          ${p.description ? `<div class="card-desc">${esc(p.description)}</div>` : ''}
          <div class="card-paths" hidden></div>
          ${summary}
          <div class="card-section doors" hidden>
            <div class="card-section-title">Continuer l’exploration</div>
            <div class="door-list"></div>
          </div>
          <div class="card-section story" hidden>
            <div class="card-section-title">Le fil de l’histoire</div>
            <div class="story-body"></div>
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
    this.bindTrail();
    const img = this.root.querySelector<HTMLImageElement>('.card-image img');
    if (img) {
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => img.parentElement?.remove());
    }
    this.root.querySelector('.card-scroll')!.scrollTop = 0;
    void this.loadDoors(p.id, token);
    void this.loadStory(p.id, token, toLite(p));
  }

  /** The story is read once by an AI: poll while it is, then lay it out and ask for scenarios. */
  private async loadStory(id: string, token: number, from: PoiLite): Promise<void> {
    const key = `story:${token}`;
    const section = this.root.querySelector<HTMLElement>('.story')!;
    const body = section.querySelector<HTMLElement>('.story-body')!;
    const started = performance.now();
    try {
      for (;;) {
        let res: StoryResponse;
        try {
          const r = await fetch(`/api/poi/${encodeURIComponent(id)}/story`);
          if (!r.ok) throw new Error(String(r.status));
          res = (await r.json()) as StoryResponse;
        } catch {
          res = { status: 'none', story: null };
        }
        if (token !== this.token) return;
        if (res.story) {
          section.hidden = false;
          this.renderStory(body, res.story);
          this.story = { id, token, story: res.story, from };
          void this.loadScenarios();
          return;
        }
        if (res.status !== 'pending' || performance.now() - started > STORY_WAIT_MS) {
          section.hidden = true;
          return;
        }
        if (section.hidden) {
          section.hidden = false;
          body.innerHTML = `<div class="story-wait">L’IA lit l’article : lieux, moments, personnages…</div>
            ${'<div class="door skeleton story-skeleton"></div>'.repeat(3)}`;
        }
        setActivity(key, { label: 'IA · fil de l’histoire', title: 'L’IA lit l’article pour ses lieux et ses personnages', ai: true });
        await new Promise((r) => setTimeout(r, STORY_POLL_MS));
      }
    } finally {
      setActivity(key, null);
    }
  }

  private renderStory(body: HTMLElement, s: Story): void {
    const life = (p: StoryPerson) =>
      p.born !== null || p.died !== null ? `${p.born !== null ? formatYear(p.born) : '?'} – ${p.died !== null ? formatYear(p.died) : ''}` : '';
    const stop = (i: number) => {
      const st = s.stops[i]!;
      return `<li><button type="button" class="story-stop" data-stop="${i}" title="${st.poi ? 'Aller à cette fiche' : 'Aller à ce lieu'}">
        <span class="story-year">${esc(formatYear(st.year))}</span>
        <span class="story-text"><span class="story-label">${esc(st.label)}</span><span class="story-name">${esc(st.poi?.title ?? st.name)}</span></span>
        ${st.poi ? '<span class="story-card" aria-label="fiche">›</span>' : '<span class="story-card story-pin" aria-label="lieu">◎</span>'}
      </button></li>`;
    };
    const phases = STORY_PHASES.map((ph) => {
      const idx = s.stops.flatMap((st, i) => (st.phase === ph ? [i] : []));
      return idx.length ? `<div class="story-phase story-${ph}"><div class="story-phase-title">${STORY_PHASE_LABELS[ph]}</div><ol class="story-stops">${idx.map(stop).join('')}</ol></div>` : '';
    }).join('');
    const people = s.people.length
      ? `<div class="story-phase"><div class="story-phase-title">Personnages <span class="story-aside">· cliquer pour suivre sur la carte</span></div>
          <div class="story-people">${s.people.map((p, i) => `
            <button type="button" class="story-person" data-person="${i}" title="Suivre ${esc(p.name)} sur la carte">
              <span class="ruler-portrait">${p.image ? `<img alt="" src="${esc(viaServer(p.image))}" referrerpolicy="no-referrer">` : esc(p.name.charAt(0))}</span>
              <span class="ruler-text"><span class="ruler-name">${esc(p.name)}</span><span class="ruler-meta">${esc([p.role, life(p)].filter(Boolean).join(' · '))}</span></span>
            </button>`).join('')}</div></div>`
      : '';
    body.innerHTML = `${phases}${people}
      <a class="door-source story-source" href="${esc(s.source.url)}" target="_blank" rel="noopener">Lu par IA dans « ${esc(s.source.title.replace(/^Wikipédia : /, ''))} » : vérifier</a>`;

    body.querySelectorAll<HTMLButtonElement>('.story-stop').forEach((b) =>
      b.addEventListener('click', () => this.onStoryStop(s.stops[Number(b.dataset.stop)]!, true)),
    );
    body.querySelectorAll<HTMLButtonElement>('.story-person').forEach((b) =>
      b.addEventListener('click', () => this.onStoryPerson(s.people[Number(b.dataset.person)]!)),
    );
    body.querySelectorAll<HTMLImageElement>('.story-person img').forEach((img) => img.addEventListener('error', () => img.remove()));
  }

  /** The filters changed: scenarios are written again for the new view (the one played goes on, it is the carnet's). */
  refreshScenarios(): void {
    if (this.story && this.story.token === this.token) void this.loadScenarios();
  }

  /** Scenarios turned on or off in the filters: off, none is asked for any more and the chip goes. */
  setScenariosOn(on: boolean): void {
    if (on === this.scenariosOn) return;
    this.scenariosOn = on;
    if (!on) {
      this.scenarioToken++;
      this.walks = [];
      this.pathsStatus = 'none';
      this.root.querySelectorAll<HTMLElement>('.card-paths').forEach((el) => {
        el.hidden = true;
        el.innerHTML = '';
      });
    } else this.refreshScenarios();
  }

  /** The path played: the chip says so when it passes through this card. */
  syncScenario(playing: ScenarioWalk | null): void {
    this.playing = playing;
    this.renderPaths();
  }

  /** Scenarios for the visitor's view (lens, themes, the cards read before), written once per view by an AI. */
  private async loadScenarios(): Promise<void> {
    const shown = this.story;
    if (!shown || !this.scenariosOn) return;
    const token = ++this.scenarioToken;
    const key = `scenarios:${token}`;
    const ctx = this.scenarioContext();
    const params = new URLSearchParams({ themes: ctx.themes.join(','), people: ctx.people ? '1' : '0' });
    if (ctx.lens) params.set('lens', ctx.lens);
    for (const t of this.trail.slice(0, -1).slice(-6)) params.append('trail', t.title);
    const started = performance.now();
    try {
      for (;;) {
        let res: ScenariosResponse;
        try {
          const r = await fetch(`/api/poi/${encodeURIComponent(shown.id)}/scenarios?${params}`);
          if (!r.ok) throw new Error(String(r.status));
          res = (await r.json()) as ScenariosResponse;
        } catch {
          res = { status: 'none', scenarios: [] };
        }
        if (token !== this.scenarioToken || this.story !== shown || shown.token !== this.token) return;
        if (res.scenarios.length) {
          const story = res.story ?? shown.story;
          this.setPaths(res.scenarios.map((sc) => walkOf(shown.from, story, sc)), 'ready');
          return;
        }
        // Scenarios already shown stay until new ones come (none for this view: the old ones still serve).
        if (res.status !== 'pending' || performance.now() - started > STORY_WAIT_MS) {
          this.setPaths(this.walks, this.walks.length ? 'ready' : res.status === 'pending' ? 'none' : res.status);
          return;
        }
        if (this.pathsStatus !== 'pending' && !this.walks.length) this.setPaths([], 'pending');
        setActivity(key, { label: 'IA · scénarios', title: 'L’IA écrit des scénarios pour votre lentille et votre exploration', ai: true });
        await new Promise((r) => setTimeout(r, STORY_POLL_MS));
      }
    } finally {
      setActivity(key, null);
    }
  }

  private setPaths(walks: ScenarioWalk[], status: CardPaths['status']): void {
    this.walks = walks;
    this.pathsStatus = status;
    this.renderPaths();
    if (this.shownLite) this.onPathsChanged({ poi: this.shownLite, walks, status });
  }

  /** "🎭 3 chemins passent ici ›": the card no longer holds the scenarios, the carnet does. */
  private renderPaths(): void {
    const box = this.root.querySelector<HTMLElement>('.card-paths');
    const poi = this.shownLite;
    if (!box || !poi || this.shown !== poi.id) return;
    const ids = new Set(this.walks.map((w) => w.id));
    const all = [...this.walks, ...(this.scenariosOn ? this.pathsThrough(poi).filter((w) => !ids.has(w.id)) : [])];
    const pending = this.pathsStatus === 'pending';
    if (!this.scenariosOn || (!all.length && !pending)) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const here = !!this.playing && all.some((w) => w.id === this.playing!.id);
    const label = all.length
      ? `<b>${all.length} chemin${all.length > 1 ? 's' : ''}</b> passe${all.length > 1 ? 'nt' : ''} par ici`
      : 'L’IA trace des chemins par ici…';
    box.hidden = false;
    box.innerHTML = `<button type="button" class="paths-chip${pending && !all.length ? ' waiting' : ''}" title="Ouvrir le carnet de route sur les chemins qui passent par cette fiche">
        <span class="paths-mask" aria-hidden="true">🎭</span>
        <span class="paths-label">${label}</span>
        ${here ? '<span class="paths-state">● en cours</span>' : pending && all.length ? '<span class="paths-state">+ en écriture…</span>' : ''}
        <span class="paths-go" aria-hidden="true">›</span>
      </button>`;
    box.querySelector('button')!.addEventListener('click', () => this.onPaths({ poi, walks: this.walks, status: this.pathsStatus }));
  }

  /** Doors arrive progressively: poll until every kind is known. */
  private async loadDoors(id: string, token: number): Promise<void> {
    const key = `doors:${token}`;
    try {
      await this.pollDoors(id, token, key);
    } finally {
      setActivity(key, null);
    }
  }

  private async pollDoors(id: string, token: number, key: string): Promise<void> {
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
      setActivity(key, { label: 'IA · causes et conséquences', title: 'L’IA lit les articles pour trouver causes et conséquences', ai: true });
      await new Promise((r) => setTimeout(r, DOOR_POLL_MS));
    }
  }

  private doorEl(d: Door): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'door';
    el.innerHTML = `
      <span class="door-icon" aria-hidden="true">${DOOR_ICONS[d.kind]}</span>
      <span class="door-text">
        <span class="door-title">${esc(d.title)}</span>
        <span class="door-dest">${esc(d.poi.title)}</span>
        <span class="door-meta">${esc(formatPoiDate(d.poi.date_start, d.poi.date_end, d.poi.date_precision))} · ${esc(d.hint)}</span>
      </span>`;
    el.addEventListener('click', () => this.onTravel(d.poi));
    const box = document.createElement('div');
    box.className = 'door-box';
    box.dataset.kind = d.kind;
    box.appendChild(el);
    // A link read by an AI says where, so it can be checked.
    if (d.source) {
      const src = document.createElement('a');
      src.className = 'door-source';
      src.href = d.source.url;
      src.target = '_blank';
      src.rel = 'noopener';
      src.textContent = `Lien lu par IA dans « ${d.source.title.replace(/^Wikipédia : /, '')} » : vérifier`;
      box.appendChild(src);
    }
    return box;
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
        if (poi.image_url) new Image().src = viaServer(poi.image_url);
      })
      .catch(() => {});
  }
}
