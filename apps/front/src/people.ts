import {
  BillboardCollection, Cartesian2, Cartesian3, Color, DistanceDisplayCondition, HorizontalOrigin, LabelCollection,
  LabelStyle, Material, NearFarScalar, PolylineCollection, VerticalOrigin,
  type Billboard, type Label, type Polyline, type Viewer,
} from 'cesium';
import { formatYear, type ArmiesResponse, type Army, type EmblemsResponse, type PersonHit, type PersonJourney } from '@way/shared';
import { armyFigure, clashFigure, FIGURE_STYLES, figureId, PALETTE, personFigure, type FigureStyle } from './figures.ts';
import { armyAt, presenceAt, type Presence, type Way } from './journey.ts';
import { fetchCached } from './localcache.ts';
import { commonsImage, loadImage, viaServer } from './media.ts';
import { findRoute, straightRoute, WaterGrid, type Route } from './routes.ts';

// People followed on the map (chosen by the viewer, remembered in the
// browser) and the armies of the wars under way, moving with the timeline.

interface Followed { qid: string; name: string; color: string }
interface Prefs { followed: Followed[]; style: FigureStyle; armies: boolean; trails: boolean; open: boolean }
const KEY = 'way:people';
const TWEEN_MS = 800;
/** Armies are shown for windows up to this many years (beyond, too many wars at once). */
const ARMIES_MAX_SPAN = 120;
const ARMIES_MAX_DECADES = 12;
/** Army lookups at once (they are slow: a decade can take Wikidata half a minute). */
const ARMY_FETCHES = 2;
/** Time spent searching new ways in one update; the rest are searched right after. */
const WAY_BUDGET_MS = 25;
const WAYS_KEPT = 6000;

function loadPrefs(): Prefs {
  const d: Prefs = { followed: [], style: 'figurine', armies: true, trails: true, open: false };
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      followed: Array.isArray(p.followed) ? p.followed.filter((f) => /^Q\d+$/.test(f.qid)).slice(0, 12) : d.followed,
      style: FIGURE_STYLES.some((s) => s.value === p.style) ? p.style! : d.style,
      armies: p.armies ?? d.armies,
      trails: p.trails ?? d.trails,
      open: p.open ?? d.open,
    };
  } catch {
    return d;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const lifespan = (b: number | null, d: number | null) =>
  b === null && d === null ? '' : `${b !== null ? formatYear(Math.floor(b)) : '?'} – ${d !== null ? formatYear(Math.floor(d)) : ''}`;

/** Something moving on the map: its figure, name, trail, and where it is heading. */
interface Actor {
  key: string;
  bb: Billboard;
  label: Label;
  trail: Polyline;
  at: [number, number] | null;
  from: [number, number] | null;
  to: [number, number] | null;
  presence: Presence | null;
  imageId: string;
}

export type Picked = { kind: 'person'; journey: PersonJourney; presence: Presence } | { kind: 'army'; army: Army; presence: Presence };

export class PeopleLayer {
  private prefs = loadPrefs();
  private journeys = new Map<string, PersonJourney>();
  private portraits = new Map<string, HTMLImageElement | null>();
  private armies = new Map<number, Army[]>();
  private armyLoading = new Set<number>();
  private armyQueue: number[] = [];
  private actors = new Map<string, Actor>();
  private billboards: BillboardCollection;
  private labels: LabelCollection;
  private trails: PolylineCollection;
  /** Crossed swords where two armies meet, by battle item, with the armies there. */
  private clashes = new Map<string, { bb: Billboard; armies: string[] }>();
  private clashBoards: BillboardCollection;
  /** Blasons → Armées: each side under its flag and in its colors. */
  private heraldry = false;
  /** Side at a decade -> its flag (null: none known). */
  private sideFlags = new Map<string, HTMLImageElement | null>();
  private flagQueue = new Map<string, { qid: string; year: number }>();
  private flagTimer: number | undefined;
  private flagTries = 0;
  /** Land, rivers and seas of the world, for the ways between places (loaded with the page). */
  private grid: WaterGrid | null = null;
  private ways = new Map<string, Route | null>();
  private wayQueue = new Map<string, [[number, number], [number, number]]>();
  private wayDeadline = 0;
  private wayTimer: number | undefined;
  private window = { tStart: 0, tEnd: 0 };
  private tween = 0;
  private searchTimer: number | undefined;
  private searchToken = 0;
  private note: HTMLElement;
  private list: HTMLElement;
  private results: HTMLElement;
  private body: HTMLElement;
  private count: HTMLElement;

  constructor(private viewer: Viewer, root: HTMLElement) {
    this.trails = viewer.scene.primitives.add(new PolylineCollection());
    this.billboards = viewer.scene.primitives.add(new BillboardCollection({ scene: viewer.scene }));
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
    this.clashBoards = viewer.scene.primitives.add(new BillboardCollection({ scene: viewer.scene }));
    root.innerHTML = `
      <button class="people-toggle" type="button" aria-expanded="false">
        <span class="people-title">Personnages</span><span class="people-count"></span><span class="people-caret">▾</span>
      </button>
      <div class="people-body" hidden>
        <input class="people-search" type="search" placeholder="Suivre un personnage…" aria-label="Chercher un personnage" autocomplete="off">
        <ul class="people-results" hidden></ul>
        <ul class="people-list"></ul>
        <div class="people-opts">
          <label>Style
            <select class="people-style">${FIGURE_STYLES.map((s) => `<option value="${s.value}">${s.label}</option>`).join('')}</select>
          </label>
          <label class="people-check"><input type="checkbox" class="people-armies"> Armées en campagne</label>
          <label class="people-check"><input type="checkbox" class="people-trails"> Tracés des parcours</label>
        </div>
        <div class="people-note"></div>
      </div>`;
    this.body = root.querySelector('.people-body')!;
    this.list = root.querySelector('.people-list')!;
    this.results = root.querySelector('.people-results')!;
    this.note = root.querySelector('.people-note')!;
    this.count = root.querySelector('.people-count')!;
    const toggle = root.querySelector<HTMLButtonElement>('.people-toggle')!;
    const setOpen = (open: boolean) => {
      this.body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      root.classList.toggle('open', open);
    };
    setOpen(this.prefs.open);
    toggle.addEventListener('click', () => {
      this.prefs.open = this.body.hidden;
      setOpen(this.prefs.open);
      this.save();
    });
    const search = root.querySelector<HTMLInputElement>('.people-search')!;
    search.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void this.search(search.value), 400);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        search.value = '';
        this.results.hidden = true;
      }
    });
    const style = root.querySelector<HTMLSelectElement>('.people-style')!;
    style.value = this.prefs.style;
    style.addEventListener('change', () => {
      this.prefs.style = style.value as FigureStyle;
      this.save();
      this.update(true);
    });
    const armies = root.querySelector<HTMLInputElement>('.people-armies')!;
    armies.checked = this.prefs.armies;
    armies.addEventListener('change', () => {
      this.prefs.armies = armies.checked;
      this.save();
      this.update(true);
    });
    const trails = root.querySelector<HTMLInputElement>('.people-trails')!;
    trails.checked = this.prefs.trails;
    trails.addEventListener('change', () => {
      this.prefs.trails = trails.checked;
      this.save();
      this.trails.show = trails.checked;
      viewer.scene.requestRender();
    });
    this.trails.show = this.prefs.trails;
    this.renderList();
    for (const f of this.prefs.followed) void this.loadJourney(f.qid);
    void fetch('/geo/water.bin')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        this.grid = WaterGrid.decode(buf);
        this.ways.clear();
        this.update(false);
      })
      .catch(() => undefined); // straight lines, as before
  }

  /** Set by the app: an army's color, the one of its country on the map. */
  colorOf: (qid: string | null, name: string) => string = () => PALETTE[0]!;

  /** Redraws the armies (the map's colors changed with the period). */
  refresh(): void {
    this.update(true);
  }

  /**
   * The way between two places, searched once: a search takes a few
   * milliseconds, so an update does what it can and leaves the rest for right after.
   */
  private way: Way = (a, b) => {
    if (!this.grid) return null;
    const key = `${a[0].toFixed(3)},${a[1].toFixed(3)}>${b[0].toFixed(3)},${b[1].toFixed(3)}`;
    const hit = this.ways.get(key);
    if (hit !== undefined) return hit;
    if (performance.now() > this.wayDeadline) {
      this.wayQueue.set(key, [a, b]);
      if (this.wayTimer === undefined) this.wayTimer = window.setTimeout(() => this.searchWays(), 0);
      return null;
    }
    return this.searchWay(key, a, b);
  };

  private searchWay(key: string, a: [number, number], b: [number, number]): Route | null {
    // No way found (the other side of the world): straight, aboard over the sea.
    const r = findRoute(this.grid!, a, b) ?? straightRoute(this.grid!, a, b);
    this.ways.set(key, r);
    if (this.ways.size > WAYS_KEPT) this.ways.delete(this.ways.keys().next().value!);
    return r;
  }

  private searchWays(): void {
    const end = performance.now() + 30;
    for (const [key, [a, b]] of this.wayQueue) {
      if (performance.now() > end) break;
      this.wayQueue.delete(key);
      if (!this.ways.has(key)) this.searchWay(key, a, b);
    }
    if (this.wayQueue.size) this.wayTimer = window.setTimeout(() => this.searchWays(), 16);
    else {
      this.wayTimer = undefined;
      this.update(false);
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.prefs));
    } catch {
      /* not remembered */
    }
  }

  // ---------- panel ----------

  private async search(text: string): Promise<void> {
    const token = ++this.searchToken;
    const q = text.trim();
    if (q.length < 2) {
      this.results.hidden = true;
      return;
    }
    this.results.hidden = false;
    this.results.innerHTML = '<li class="people-empty">Recherche…</li>';
    try {
      const r = await fetch(`/api/people/search?${new URLSearchParams({ q })}`);
      if (!r.ok) throw new Error(String(r.status));
      const hits = (await r.json()) as PersonHit[];
      if (token !== this.searchToken) return;
      this.results.innerHTML = hits.length
        ? hits.map((h, i) => `
            <li><button type="button" data-i="${i}">
              ${h.image ? `<img alt="" src="${esc(viaServer(h.image))}" referrerpolicy="no-referrer">` : '<span class="people-noimg"></span>'}
              <span><b>${esc(h.name)}</b><small>${esc([lifespan(h.born, h.died), h.description].filter(Boolean).join(' · '))}</small></span>
            </button></li>`).join('')
        : '<li class="people-empty">Personne de ce nom dans Wikidata.</li>';
      this.results.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) =>
        b.addEventListener('click', () => {
          const h = hits[Number(b.dataset.i)]!;
          this.follow(h);
          this.results.hidden = true;
          (this.body.querySelector('.people-search') as HTMLInputElement).value = '';
        }),
      );
    } catch {
      if (token === this.searchToken) this.results.innerHTML = '<li class="people-empty">Wikidata ne répond pas pour le moment.</li>';
    }
  }

  private follow(h: PersonHit): void {
    if (this.prefs.followed.some((f) => f.qid === h.qid)) return;
    const used = new Set(this.prefs.followed.map((f) => f.color));
    const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[this.prefs.followed.length % PALETTE.length]!;
    this.prefs.followed.push({ qid: h.qid, name: h.name, color });
    this.save();
    this.renderList();
    void this.loadJourney(h.qid, true);
  }

  private unfollow(qid: string): void {
    this.prefs.followed = this.prefs.followed.filter((f) => f.qid !== qid);
    this.save();
    this.removeActor(`p:${qid}`);
    this.renderList();
    this.viewer.scene.requestRender();
  }

  private renderList(): void {
    const n = this.prefs.followed.length;
    this.count.textContent = n ? String(n) : '';
    this.list.innerHTML = this.prefs.followed.map((f) => {
      const j = this.journeys.get(f.qid);
      const p = this.actors.get(`p:${f.qid}`)?.presence;
      const state = !j ? 'Chargement du parcours…' : p ? p.text : this.whenAbsent(j);
      return `
        <li data-qid="${f.qid}">
          <button type="button" class="people-color" title="Changer de couleur" style="background:${f.color}"></button>
          <button type="button" class="people-name" title="Aller le voir"><b>${esc(f.name)}</b><small>${esc(state)}</small></button>
          <button type="button" class="people-remove" title="Ne plus suivre" aria-label="Ne plus suivre">×</button>
        </li>`;
    }).join('');
    this.list.querySelectorAll<HTMLLIElement>('li[data-qid]').forEach((li) => {
      const qid = li.dataset.qid!;
      li.querySelector('.people-remove')!.addEventListener('click', () => this.unfollow(qid));
      li.querySelector('.people-color')!.addEventListener('click', () => {
        const f = this.prefs.followed.find((x) => x.qid === qid)!;
        f.color = PALETTE[(PALETTE.indexOf(f.color) + 1) % PALETTE.length]!;
        this.save();
        this.renderList();
        this.update(true);
      });
      li.querySelector('.people-name')!.addEventListener('click', () => this.onGoTo(qid));
    });
    if (!n) this.note.textContent = 'Cherchez un nom pour suivre sa vie sur la carte : études, voyages, combats, couronnement…';
    else this.note.textContent = '';
  }

  private whenAbsent(j: PersonJourney): string {
    const t = (this.window.tStart + this.window.tEnd) / 2;
    if (j.born !== null && t < j.born) return `Naîtra en ${formatYear(Math.floor(j.born))}`;
    if (j.died !== null && t > j.died) return `Mort en ${formatYear(Math.floor(j.died))}`;
    return 'Aucun lieu connu à cette date';
  }

  /** Set by the app: fly to someone (and bring the timeline into their life). */
  onGoTo: (qid: string) => void = () => undefined;

  journey(qid: string): PersonJourney | undefined {
    return this.journeys.get(qid);
  }

  // ---------- data ----------

  private async loadJourney(qid: string, goThere = false): Promise<void> {
    try {
      await fetchCached<PersonJourney>(`/api/people/${qid}`, (j) => {
        this.journeys.set(qid, j);
        if (j.image && !this.portraits.has(j.image)) this.loadPortrait(j.image);
        this.update(true);
        this.renderList();
      });
      if (goThere) this.onGoTo(qid);
    } catch {
      this.note.textContent = 'Parcours indisponible pour le moment (Wikidata) : réessayez plus tard.';
    }
  }

  private loadPortrait(url: string): void {
    this.portraits.set(url, null);
    const img = new Image();
    img.crossOrigin = 'anonymous'; // drawn into a WebGL texture: must not taint the canvas
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      this.portraits.set(url, img);
      if (this.prefs.style === 'medallion') this.update(true);
    };
    img.src = viaServer(url);
  }

  private decadesInView(): number[] | null {
    const { tStart, tEnd } = this.window;
    if (tEnd - tStart > ARMIES_MAX_SPAN) return null;
    const out: number[] = [];
    for (let d = Math.floor(tStart / 10) * 10; d <= tEnd && out.length < ARMIES_MAX_DECADES; d += 10) out.push(d);
    return out;
  }

  /**
   * Armies of a decade, queued: a decade can take Wikidata half a minute, and
   * the browser only opens a few connections to the server. At most
   * ARMY_FETCHES at once, so the borders (and the points) never wait behind
   * them while the timeline plays; decades the timeline has passed meanwhile
   * are dropped.
   */
  private loadArmies(decade: number): void {
    if (this.armies.has(decade) || this.armyLoading.has(decade) || this.armyQueue.includes(decade)) return;
    this.armyQueue.push(decade);
    this.pumpArmies();
  }

  private pumpArmies(): void {
    while (this.armyLoading.size < ARMY_FETCHES && this.armyQueue.length) {
      const decade = this.armyQueue.shift()!;
      const inView = this.decadesInView() ?? [];
      if (!inView.includes(decade) && !inView.includes(decade - 10)) continue;
      this.armyLoading.add(decade);
      fetchCached<ArmiesResponse>(`/api/armies?decade=${decade}`, (r) => {
        this.armies.set(decade, r.armies);
        this.update(false);
      })
        .catch(() => undefined)
        .finally(() => {
          this.armyLoading.delete(decade);
          this.pumpArmies();
        });
    }
  }

  // ---------- map ----------

  /** Time shown, in decimal years (a day is about 0.0027). */
  setWindow(tStart: number, tEnd: number): void {
    this.window = { tStart, tEnd };
    this.update(false);
  }

  setHeraldry(on: boolean): void {
    if (on === this.heraldry) return;
    this.heraldry = on;
    this.update(true);
  }

  /** Decade key of a side's flag: flags change with regimes. */
  private flagKey(a: Army): string | null {
    if (!a.sideQid) return null;
    return `${a.sideQid}|${Math.floor((a.battles[0]?.t ?? 0) / 10) * 10}`;
  }

  /** The side's flag once known and loaded; asks for it otherwise. */
  private sideFlag(a: Army): HTMLImageElement | null {
    const key = this.flagKey(a);
    if (!key) return null;
    if (!this.sideFlags.has(key) && !this.flagQueue.has(key)) {
      this.flagQueue.set(key, { qid: a.sideQid!, year: Math.floor(a.battles[0]?.t ?? 0) });
      clearTimeout(this.flagTimer);
      this.flagTimer = window.setTimeout(() => void this.loadFlags(), 300);
    }
    return this.sideFlags.get(key) ?? null;
  }

  /** Flags of the sides in view, grouped by year, then their images. */
  private async loadFlags(): Promise<void> {
    const byYear = new Map<number, string[]>();
    for (const { qid, year } of this.flagQueue.values()) byYear.set(year, [...(byYear.get(year) ?? []), qid]);
    let pending = false;
    for (const [year, qids] of byYear) {
      try {
        const r = await fetch(`/api/emblems?${new URLSearchParams({ qids: [...new Set(qids)].slice(0, 100).join(','), year: String(year) })}`);
        if (!r.ok) continue;
        const res = (await r.json()) as EmblemsResponse;
        pending ||= res.pending > 0;
        for (const qid of new Set(qids)) {
          const key = `${qid}|${Math.floor(year / 10) * 10}`;
          const e = res.emblems[qid];
          const file = e ? (e.flag ?? e.coa) : null;
          if (!file) {
            if (res.pending === 0) {
              this.sideFlags.set(key, null);
              this.flagQueue.delete(key);
            }
            continue;
          }
          this.flagQueue.delete(key);
          this.sideFlags.set(key, null);
          void loadImage(commonsImage(file, 120)).then((img) => {
            if (!img) {
              window.setTimeout(() => this.sideFlags.delete(key), 60_000);
              return;
            }
            this.sideFlags.set(key, img);
            if (this.heraldry) this.update(true);
          });
        }
      } catch {
        /* plain banners */
      }
    }
    // Wikidata is being asked in the background: come back for the rest.
    if (pending && this.flagQueue.size && this.flagTries++ < 10) this.flagTimer = window.setTimeout(() => void this.loadFlags(), 6000);
    else this.flagTries = 0;
  }

  /** Recomputes where everyone is; `redraw` also rebuilds their figures (style, color). */
  private update(redraw: boolean): void {
    const { tStart, tEnd } = this.window;
    const t = (tStart + tEnd) / 2;
    // An event holds someone for a share of the window: yearly steps still catch a battle,
    // and day by day, a battle lasts a couple of days.
    const tol = Math.max(2 / 365, (tEnd - tStart) / 10);
    const seen = new Set<string>();
    this.wayDeadline = performance.now() + WAY_BUDGET_MS;
    for (const f of this.prefs.followed) {
      const j = this.journeys.get(f.qid);
      if (!j) continue;
      const p = presenceAt(j, t, tol, this.way);
      const key = `p:${f.qid}`;
      if (!p) continue;
      seen.add(key);
      const portrait = j.image ? this.portraits.get(j.image) ?? null : null;
      const image = personFigure(this.prefs.style, f.color, p.kind, f.name, portrait);
      this.place(key, p, image, `${f.name}\n${p.text}`, Color.fromCssColorString(f.color), false, redraw);
    }
    const decades = this.prefs.armies ? this.decadesInView() : null;
    if (decades) {
      for (const d of decades) this.loadArmies(d);
      // Playing forward: the next decade is on its way before the window gets there.
      if (tEnd - Math.floor(tEnd / 10) * 10 > 6) this.loadArmies(decades[decades.length - 1]! + 10);
      const byId = new Map<string, Army>();
      for (const d of decades) for (const a of this.armies.get(d) ?? []) {
        const cur = byId.get(a.id);
        if (!cur || a.battles.length > cur.battles.length) byId.set(a.id, a);
      }
      const here: { a: Army; p: Presence; spot: string }[] = [];
      for (const a of byId.values()) {
        const p = armyAt(a, t, tol, this.way);
        if (p) here.push({ a, p, spot: p.ref ?? `${p.lat.toFixed(2)},${p.lon.toFixed(2)}` });
      }
      const bySpot = new Map<string, typeof here>();
      for (const h of here) bySpot.set(h.spot, [...(bySpot.get(h.spot) ?? []), h]);
      for (const group of bySpot.values()) {
        group.forEach(({ a, p }, i) => {
          const key = `a:${a.id}`;
          seen.add(key);
          const flag = this.heraldry ? this.sideFlag(a) : null;
          // The color of its country on the map.
          const color = this.colorOf(a.sideQid, a.side);
          // Sides at the same place stand apart, facing each other.
          const offset = (i - (group.length - 1) / 2) * 62;
          this.place(key, p, armyFigure(color, p.kind, flag), a.side, Color.fromCssColorString(color), true, redraw, offset);
        });
        // Two armies at the same battle: they clash.
        const ref = group[0]!.p.ref;
        const fighting = group.filter((h) => h.p.kind === 'battle');
        if (ref && fighting.length >= 2) {
          const key = `c:${ref}`;
          seen.add(key);
          this.placeClash(key, fighting[0]!.p, fighting.map((h) => `a:${h.a.id}`));
        }
      }
    }
    for (const [key, c] of this.clashes) {
      if (seen.has(key)) continue;
      this.clashBoards.remove(c.bb);
      this.clashes.delete(key);
    }
    for (const key of [...this.actors.keys()]) if (!seen.has(key)) this.removeActor(key);
    this.animate();
    if (this.prefs.open) this.renderList();
  }

  /** The clash sign over a battle, popping in when the armies meet. */
  private placeClash(key: string, p: Presence, armies: string[]): void {
    const cur = this.clashes.get(key);
    if (cur) {
      cur.armies = armies;
      return;
    }
    const bb = this.clashBoards.add({
      position: Cartesian3.fromDegrees(p.lon, p.lat, 1500), image: clashFigure() as unknown as string,
      verticalOrigin: VerticalOrigin.CENTER, pixelOffset: new Cartesian2(0, -44), scale: 0.1,
      disableDepthTestDistance: 5e4, scaleByDistance: new NearFarScalar(3e5, 1.15, 2e7, 0.55), id: key,
    });
    this.clashes.set(key, { bb, armies });
    const start = performance.now();
    const pop = () => {
      if (this.clashes.get(key)?.bb !== bb) return;
      const k = Math.min(1, (performance.now() - start) / 450);
      // Overshoots a little, like a blow.
      bb.scale = 0.1 + 0.9 * (1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2);
      this.viewer.scene.requestRender();
      if (k < 1) requestAnimationFrame(pop);
    };
    requestAnimationFrame(pop);
  }

  private place(key: string, p: Presence, image: HTMLCanvasElement, text: string, color: Color, army: boolean, redraw: boolean, offset = 0): void {
    let a = this.actors.get(key);
    const target: [number, number] = [p.lat, p.lon];
    if (!a) {
      const position = Cartesian3.fromDegrees(p.lon, p.lat, 1500);
      a = {
        key,
        bb: this.billboards.add({
          position, verticalOrigin: VerticalOrigin.BOTTOM, scale: army ? 0.8 : 1,
          disableDepthTestDistance: 5e4, scaleByDistance: new NearFarScalar(3e5, 1.15, 2e7, 0.55),
          id: key,
        }),
        label: this.labels.add({
          position, text, font: army ? '500 11px "Inter Variable", system-ui, sans-serif' : '600 12px "Inter Variable", system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#f4ead6'), outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.9),
          outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.TOP, horizontalOrigin: HorizontalOrigin.CENTER,
          pixelOffset: new Cartesian2(0, 4), disableDepthTestDistance: 5e4, id: key,
          // Armies are many: their side is named only up close (the rest is in the tooltip).
          distanceDisplayCondition: army ? new DistanceDisplayCondition(0, 1.2e6) : undefined,
        }),
        trail: this.trails.add({ positions: [position, position], width: army ? 1.5 : 2.2, material: Material.fromType('PolylineDash', { color: color.withAlpha(army ? 0.45 : 0.75), dashLength: 14 }) }),
        at: target, from: null, to: null, presence: p, imageId: '',
      };
      this.actors.set(key, a);
    }
    const id = figureId(image);
    if (redraw || a.imageId !== id) {
      a.bb.setImage(id, image);
      a.imageId = id;
    }
    a.label.text = text;
    a.bb.pixelOffset = new Cartesian2(offset, 0);
    a.label.pixelOffset = new Cartesian2(offset, 4);
    a.presence = p;
    a.from = a.at;
    a.to = target;
    const pts = p.trail.slice(-400).map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, 1200));
    a.trail.positions = pts.length >= 2 ? pts : [pts[0] ?? a.bb.position, pts[0] ?? a.bb.position];
  }

  private removeActor(key: string): void {
    const a = this.actors.get(key);
    if (!a) return;
    this.billboards.remove(a.bb);
    this.labels.remove(a.label);
    this.trails.remove(a.trail);
    this.actors.delete(key);
  }

  /** Figures glide to their new places. */
  private animate(): void {
    const token = ++this.tween;
    const start = performance.now();
    const step = () => {
      if (token !== this.tween) return;
      const k = Math.min(1, (performance.now() - start) / TWEEN_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      for (const a of this.actors.values()) {
        if (!a.to) continue;
        const from = a.from ?? a.to;
        const lat = from[0] + (a.to[0] - from[0]) * e;
        // The short way round the antimeridian.
        let dLon = a.to[1] - from[1];
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        const lon = from[1] + dLon * e;
        a.at = [lat, lon];
        const pos = Cartesian3.fromDegrees(lon, lat, 1500);
        a.bb.position = pos;
        a.label.position = pos;
      }
      this.viewer.scene.requestRender();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** The person or army under the cursor. */
  pick(position: Cartesian2): Picked | null {
    const hit = this.viewer.scene.pick(position) as { id?: unknown } | undefined;
    let key = typeof hit?.id === 'string' ? hit.id : null;
    // The clash sign stands for the armies fighting there.
    if (key?.startsWith('c:')) key = this.clashes.get(key)?.armies[0] ?? null;
    const a = key ? this.actors.get(key) : undefined;
    if (!a?.presence) return null;
    if (key!.startsWith('p:')) {
      const j = this.journeys.get(key!.slice(2));
      return j ? { kind: 'person', journey: j, presence: a.presence } : null;
    }
    for (const list of this.armies.values()) {
      const army = list.find((x) => `a:${x.id}` === key);
      if (army) return { kind: 'army', army, presence: a.presence };
    }
    return null;
  }

  /** Where a followed person is now (or will first be seen). */
  whereIs(qid: string): { lat: number; lon: number; year: number | null } | null {
    const a = this.actors.get(`p:${qid}`);
    if (a?.at) return { lat: a.at[0], lon: a.at[1], year: null };
    const j = this.journeys.get(qid);
    const s = j?.stops.find((x) => x.lat !== null);
    return s ? { lat: s.lat!, lon: s.lon!, year: s.start } : null;
  }
}
