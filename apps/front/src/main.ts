import './cesium-base.ts';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/eb-garamond/500-italic.css';
import '@fontsource-variable/inter';
import './style.css';

import { ScreenSpaceEventType, Cartesian2, BoundingSphere, Cartesian3, Cartographic, Math as CesiumMath, Rectangle, type Entity } from 'cesium';
import {
  cellsForRect, formatPoiDate, formatYear, isGlobalSearchRes, MAX_YEAR, MIN_YEAR, rectAreaKm2, resolutionForArea, ringAround, CATEGORY_LABELS,
  ALL_THEMES, THEMES, walkOf, type Backdrop, type Category, type DetourKind, type PersonScenarioResponse, type PoiLite, type ScenarioWalk,
  type DoorsResponse, type ScenariosResponse, type StepResponse, type Story, type StoryPerson, type StoryResponse, type SubdivisionsResponse,
  type ThemeFilter, type ViewMessage,
} from '@way/shared';
import { currentActivity, onActivity, setActivity } from './activity.ts';
import { BordersLayer, realmKey, type BorderShape } from './borders.ts';
import { Card, type CardPaths } from './card.ts';
import { CastLayer, type CastMember } from './cast.ts';
import { Connection } from './connection.ts';
import { bounds, contains, divide, type Area, type Region } from './divisions.ts';
import { Filters, importanceFloor, type Heraldry, type Scale } from './filters.ts';
import { GeographyLayer, NO_GEOGRAPHY, type Geography } from './geography.ts';
import { formatPop, LivingLayer, NO_LIVING, type Living, type LivingPick } from './living.ts';
import { cameraState, createGlobe, restoreCamera, setBasemap, setPaper, viewRect, type Basemap, type CameraState } from './globe.ts';
import { PoiLayer } from './markers.ts';
import { PeopleLayer, type Picked } from './people.ts';
import { Carnet, ScenarioLibrary, type Here, type LeadFrom, type StepDoors } from './scenario.ts';
import { SearchBox } from './search.ts';
import { StoryLayer } from './storymap.ts';
import { EntityMenu } from './entity.ts';
import { fetchCached } from './localcache.ts';
import { loadUiSettings, playSound } from './sounds.ts';
import { Timeline, type TimeWindow } from './timeline.ts';

// ---------- persisted per-viewer preferences ----------
interface Saved {
  camera?: CameraState; window?: TimeWindow; basemap?: Basemap; scale?: Scale; heraldry?: Heraldry; geography?: Geography;
  themes?: ThemeFilter; backdrop?: Backdrop; detailed?: boolean; living?: Living;
  /** Scenarios written by the AI and offered (on unless turned off). */
  scenarios?: boolean;
  /** Hidden categories, before themes (read once, then replaced by `themes`). */
  hidden?: Category[];
}
const STORAGE_KEY = 'orbis:state';
/** The app was called Way: its preferences are taken over. */
const OLD_STORAGE_KEY = 'way:state';
function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
const saved = load();
function save(patch: Partial<Saved>): void {
  Object.assign(saved, patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* storage unavailable: preferences are just not remembered */
  }
}

// ---------- globe ----------
let basemap: Basemap = saved.basemap ?? 'natural-earth';
const viewer = createGlobe(document.getElementById('globe')!, basemap);
if (saved.camera) restoreCamera(viewer, saved.camera);
else viewer.camera.setView({ destination: Cartesian3.fromDegrees(20, 30, 9_000_000) }); // the Mediterranean world

if (import.meta.env.DEV) (window as unknown as { __viewer: unknown }).__viewer = viewer; // debugging aid

const geography = new GeographyLayer(viewer);
const pois = new PoiLayer(viewer);
const people = new PeopleLayer(viewer, document.getElementById('people')!);
const living = new LivingLayer(viewer);

// ---------- timeline & borders ----------
const timelineEl = document.getElementById('timeline')!;
let bordersTimer: number | undefined;
let bordersAt = 0;
/**
 * Borders follow the timeline live, while it plays or is dragged: at most
 * one period change every BORDERS_EVERY_MS, and always the last one.
 */
const BORDERS_EVERY_MS = 200;
function followBorders(): void {
  clearTimeout(bordersTimer);
  const apply = () => {
    bordersAt = performance.now();
    const { tStart, tEnd } = timeline.window;
    void borders.setYear(Math.round((tStart + tEnd) / 2));
  };
  const wait = BORDERS_EVERY_MS - (performance.now() - bordersAt);
  if (wait <= 0) apply();
  else bordersTimer = window.setTimeout(apply, wait);
}
const timeline = new Timeline(timelineEl, saved.window ?? { tStart: -500, tEnd: -300 }, (w, moment) => {
  pois.setWindow(w.tStart, w.tEnd);
  people.setWindow(moment.tStart, moment.tEnd);
  living.setWindow(w.tStart, w.tEnd, (moment.tStart + moment.tEnd) / 2);
  filters.setCounts(pois.inWindow());
  followBorders();
  save({ window: moment });
  stopIdle();
  scheduleSearch();
});
const borders = new BordersLayer(viewer, (t) => timeline.setBordersNote(t));
// Armies wear the colors of their country on the map.
people.colorOf = (qid, name) => borders.colorOf(qid, name);
// A new period: armies take their colors again, the selected territory and its regions follow.
borders.onPeriod = () => {
  people.refresh();
  followTerritory();
};
pois.setWindow(timeline.window.tStart, timeline.window.tEnd);
people.setWindow(timeline.moment.tStart, timeline.moment.tEnd);
living.setWindow(timeline.window.tStart, timeline.window.tEnd, (timeline.moment.tStart + timeline.moment.tEnd) / 2);

/** Following someone: to where they are, and into their lifetime if the window is outside it. */
people.onGoTo = (qid) => {
  const j = people.journey(qid);
  const t = (timeline.window.tStart + timeline.window.tEnd) / 2;
  if (j && ((j.born !== null && t < j.born) || (j.died !== null && t > j.died))) {
    const first = j.stops.find((s) => s.lat !== null && s.kind !== 'birth') ?? j.stops[0];
    if (first) timeline.glideTo(first.start);
  }
  window.setTimeout(() => {
    const at = people.whereIs(qid);
    if (at) viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(at.lon, at.lat, 2_500_000), duration: 1.6 });
  }, 400);
};

function openFigure(f: Picked): void {
  elsewhere();
  clearTerritory();
  pois.select(null);
  const goTo = (year: number, lat: number | null, lon: number | null) => {
    timeline.glideTo(year);
    if (lat !== null && lon !== null) viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, 1_500_000), duration: 1.6 });
  };
  if (f.kind === 'person') {
    playSound('person');
    card.openPerson(f.journey, f.presence.text, (s) => goTo(s.start, s.lat, s.lon));
  } else {
    playSound('army');
    card.openArmy(f.army, f.presence.text, (b) => goTo(b.t, b.lat, b.lon));
  }
}

/** Tooltip of a city or a flow's place under the cursor. */
function livingAt(at: Cartesian2): { title: string; meta: string } | null {
  const l = living.pick(at);
  if (!l) return null;
  if (l.kind === 'city') return { title: l.city[0], meta: `${formatPop(l.pop)} habitants · ${l.city[1]}` };
  const s = l.flow.stages[l.stage]!;
  return { title: `${s.place} : ${s.note}`, meta: `${l.def.title} · ${formatYear(s.year)}` };
}

/** A city or a flow clicked: its card; a flow's places take the map and the timeline there. */
function openLiving(l: LivingPick): void {
  elsewhere();
  clearTerritory();
  pois.select(null);
  const mid = (timeline.moment.tStart + timeline.moment.tEnd) / 2;
  if (l.kind === 'city') {
    playSound('city');
    card.openCity(l.city, l.pop, l.sure, mid);
    return;
  }
  playSound(l.def.kind === 'trade' ? 'trade' : l.def.kind === 'epidemic' ? 'disaster' : 'religion');
  card.openFlow(l.def, l.flow, l.stage, (s) => {
    timeline.glideTo(s.year);
    viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(s.lon, s.lat, 2_500_000), duration: 1.6 });
  });
}

// ---------- filters ----------
const savedThemes: ThemeFilter = saved.themes
  ?? (saved.hidden
    ? { hiddenThemes: [], hiddenCats: saved.hidden.filter((c) => c !== 'person'), people: !saved.hidden.includes('person') }
    : ALL_THEMES);
/** Set once the card exists: the filters changed, its scenarios follow the new view. */
let refreshScenarios = (): void => undefined;
const filters = new Filters(
  document.getElementById('filters')!,
  savedThemes,
  (themes) => {
    pois.setFilter(filters.shown);
    filters.setCounts(pois.inWindow());
    save({ themes, hidden: undefined });
    refreshScenarios();
  },
  saved.backdrop ?? 'political',
  (backdrop) => {
    save({ backdrop });
    borders.setBackdrop(backdrop);
    refreshScenarios();
    syncPaper();
  },
  saved.scale ?? 'selection',
  (scale) => {
    save({ scale });
    applyZoom();
  },
  saved.heraldry ?? { territories: false, armies: false },
  (heraldry) => {
    save({ heraldry });
    borders.setHeraldry(heraldry.territories);
    people.setHeraldry(heraldry.armies);
    syncPaper();
  },
  { ...NO_GEOGRAPHY, ...saved.geography },
  (g) => {
    save({ geography: g });
    geography.set(g);
  },
  saved.detailed ?? false,
  (detailed) => save({ detailed }),
  { ...NO_LIVING, ...saved.living },
  (l) => {
    save({ living: l });
    living.set(l);
  },
  saved.scenarios ?? true,
  (on) => {
    save({ scenarios: on });
    card.setScenariosOn(on);
    // Turned off: the scenario played stops where it is, nothing more is asked of the AI.
    if (!on) {
      writeToken++;
      placeToken++;
      carnet.stop();
    }
  },
);
living.onStatus = (text) => filters.setLivingNote(text);
living.set(filters.living);
geography.set(filters.geography);
borders.setBackdrop(filters.backdrop);
borders.setHeraldry(filters.heraldry.territories);
people.setHeraldry(filters.heraldry.armies);
pois.setFilter(filters.shown);
syncPaper();

/** Coats of arms on the territories: the basemap turns to white paper so they stand out. */
function syncPaper(): void {
  const on = filters.heraldry.territories && filters.backdrop !== 'none';
  setPaper(viewer, on);
  borders.setPaper(on);
}

/** Semantic zoom: the camera height and the impact scale set the importance floor. */
function applyZoom(): void {
  pois.setMinImportance(importanceFloor(filters.scale, viewer.camera.positionCartographic.height));
}
applyZoom();

// ---------- basemap switch ----------
const basemapButtons = document.querySelectorAll<HTMLButtonElement>('[data-basemap]');
const syncBasemap = () => basemapButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.basemap === basemap)));
basemapButtons.forEach((b) =>
  b.addEventListener('click', () => {
    const next = b.dataset.basemap as Basemap;
    if (next === basemap) return;
    basemap = next;
    setBasemap(viewer, basemap);
    syncBasemap();
    save({ basemap });
  }),
);
syncBasemap();

// ---------- card ----------
const card = new Card(
  document.getElementById('card')!,
  () => {
    pois.select(null);
    clearTerritory();
  },
  travel,
);
/**
 * Looks straight down on a point from `height`, the point in the middle of
 * the map left visible between the filters and the card (not under the card).
 */
function flyToVisible(lat: number, lon: number, height: number): void {
  const canvas = viewer.scene.canvas;
  const rect = (id: string) => {
    const el = document.getElementById(id);
    return el && !el.hidden ? el.getBoundingClientRect() : null;
  };
  // A path played: its film along the bottom, the panels on the left step aside; the map left visible is above it.
  const film = document.querySelector('.carnet.playing .film')?.getBoundingClientRect();
  const phone = canvas.clientWidth <= 640;
  const left = film || phone ? 0 : rect('filters')?.right ?? 0;
  const right = phone ? canvas.clientWidth : rect('card')?.left ?? canvas.clientWidth;
  const shiftPx = canvas.clientWidth / 2 - (left + right) / 2;
  const f = viewer.camera.frustum as { fov?: number; aspectRatio?: number };
  const aspect = f.aspectRatio ?? canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const fov = f.fov ?? Math.PI / 3;
  const fovX = aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) * aspect);
  const metersPerPx = (2 * height * Math.tan(fovX / 2)) / Math.max(1, canvas.clientWidth);
  // The camera moves east of the point, so the point shows left of the center.
  const dLon = (shiftPx * metersPerPx) / (111_320 * Math.max(0.1, Math.cos(CesiumMath.toRadians(lat))));
  // The camera moves south, the point shows above the film.
  const shiftPy = film ? canvas.clientHeight / 2 - film.top / 2 : 0;
  const dLat = Math.min(30, (shiftPy * metersPerPx) / 111_320);
  viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon + dLon, Math.max(-89, lat - dLat), height), duration: 1.6 });
}

// The open card's story on the globe: its places, doors into their own stories.
const storyMap = new StoryLayer(viewer);
/** The story of the card shown, drawn again when no path plays (a path draws its own steps). */
let shownStory: Story | null = null;
card.onStory = (shown) => {
  shownStory = shown?.story ?? null;
  if (carnet.playing && !carnet.isPaused) return;
  if (shownStory) storyMap.show(shownStory);
  else storyMap.clear();
};
const storyBack = () => (shownStory ? storyMap.show(shownStory) : storyMap.clear());

/** A stop of a card's story: there, at the story's moment (a port's own card would take the timeline to its founding). */
card.onStoryStop = (s, openCard) => {
  elsewhere();
  clearTerritory();
  timeline.glideTo(s.year);
  flyToVisible(s.lat, s.lon, s.poi ? 600_000 : 1_200_000);
  if (!s.poi) return;
  pois.upsert([s.poi]);
  pois.select(s.poi.id);
  if (openCard) {
    playSound(s.poi.category);
    void card.open(s.poi.id);
  }
};
card.onStoryPerson = (p) => {
  elsewhere();
  playSound('person');
  people.follow({ qid: p.qid, name: p.name, description: p.role, born: p.born, died: p.died, image: p.image });
};

// ---------- scenarios: the carnet de route, over the globe ----------
const cast = new CastLayer(viewer);
const library = new ScenarioLibrary();
const carnet = new Carnet(document.getElementById('scenario')!, () => library.all);
/** Where the visitor was when the first path started: quitting brings them back. */
let beforeScenario: { year: number; camera: CameraState } | null = null;
const viewContext = () => ({
  lens: filters.lens,
  themes: THEMES.filter((t) => !filters.themes.hiddenThemes.includes(t)),
  people: filters.themes.people,
});
/** The visitor's view as query parameters, for what the AI writes. */
function viewParams(): URLSearchParams {
  const ctx = viewContext();
  const params = new URLSearchParams({ themes: ctx.themes.join(','), people: ctx.people ? '1' : '0' });
  if (ctx.lens) params.set('lens', ctx.lens);
  return params;
}
card.scenarioContext = viewContext;
refreshScenarios = () => card.refreshScenarios();
card.setScenariosOn(filters.scenarios);
card.pathsThrough = (poi) => library.through({ poi });
carnet.onMet = (w) => library.add([w]);

/** The paths through a card: its own scenarios, then those met elsewhere passing there. */
function cardHere(at: CardPaths): Here {
  const ids = new Set(at.walks.map((w) => w.id));
  return { key: at.poi.id, title: at.poi.title, poi: at.poi, status: at.status, walks: [...at.walks, ...library.through({ poi: at.poi }).filter((w) => !ids.has(w.id))] };
}
const personHere = (p: StoryPerson): Here => ({ key: p.qid, title: p.name, person: p, status: 'ready', walks: library.through({ qid: p.qid }) });
card.onPaths = (at) => carnet.showHere(cardHere(at));
card.onPathsChanged = (at) => {
  library.add(at.walks);
  carnet.updateHere(cardHere(at));
};
card.onPersonPaths = (p) => carnet.showHere(personHere(p));
carnet.onChange = () => card.syncScenario(carnet.playing?.walk ?? null);
carnet.onStep = (walk, j) => {
  const step = walk.steps[j]!;
  beforeScenario ??= { year: (timeline.moment.tStart + timeline.moment.tEnd) / 2, camera: cameraState(viewer) };
  clearTerritory();
  playSound(step.poi?.category ?? 'person');
  timeline.glideTo(step.year);
  storyMap.showWalk(walk.steps, j);
  // The card beside the film follows the step: its place's card, else the card the path was written on.
  // A phone has no room beside: the map shows above the film, the card waits.
  const beside = step.poi ?? walk.from;
  if (window.innerWidth <= 640) {
    if (card.currentPoi) card.close();
  } else if (beside) {
    pois.upsert([beside]);
    if (card.currentPoi !== beside.id) void card.open(beside.id);
  }
  // Once the card is laid out: the map flies to the part left visible.
  requestAnimationFrame(() => flyToVisible(step.lat, step.lon, 900_000));
  // The protagonist stands on the spot: "Vous" for an invented one, the real person otherwise.
  const members: CastMember[] = step.cast.map((p) => ({ name: p.name, role: p.role, image: p.image, you: p.qid === walk.hero?.qid }));
  if (walk.invented) members.unshift({ name: 'Vous', role: walk.title, image: null, you: true });
  else if (walk.hero && !step.cast.some((p) => p.qid === walk.hero!.qid)) {
    members.unshift({ name: walk.hero.name, role: walk.hero.role, image: walk.hero.image, you: true });
  }
  cast.show(step, members);
};
carnet.onPause = () => {
  cast.clear();
  storyBack();
};
carnet.onEnd = (restore) => {
  cast.clear();
  storyBack();
  const back = beforeScenario;
  beforeScenario = null;
  if (!restore || !back) return;
  timeline.glideTo(back.year);
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(back.camera.lon, back.camera.lat, back.camera.height),
    orientation: { heading: back.camera.heading, pitch: back.camera.pitch, roll: 0 },
    duration: 1.6,
  });
};
carnet.onOpenCard = (poi) => {
  clearTerritory();
  pois.upsert([poi]);
  pois.select(poi.id);
  void card.open(poi.id);
};
carnet.onNeedText = (walk, j) => void writeStep(walk, j);

// A name to act on, wherever it shows (a ruler, a person of a story, a link of a card's text, someone at a step).
const entities = new EntityMenu();
entities.onFollow = (p) => {
  elsewhere();
  playSound('person');
  people.follow({ qid: p.qid, name: p.name, description: p.role, born: p.born, died: p.died, image: p.image });
};
entities.onPersonPaths = (p) => carnet.showHere(personHere(p));
entities.onLife = (p) => void lifeScenario(p, !!carnet.playing && !carnet.isPaused);
entities.onOpenCard = (poi) => carnet.onOpenCard(poi);
entities.onPlacePaths = (poi) => void placePaths(poi);
entities.onFlyTo = (lat, lon) => flyToVisible(lat, lon, 600_000);
card.onEntity = (el, e) => entities.show(el, e);
carnet.onEntity = (el, e) => entities.show(el, e);
carnet.doorsFor = (poi) => doorsOf(poi);
carnet.onLead = (lead, how, at) => {
  if (lead.kind === 'person') {
    if (how === 'full') void lifeScenario(lead.person, true);
    else void detour('person', lead.person.qid, lead.person.name, at);
  } else if (how === 'full') void placePaths(lead.poi);
  // A card too thin for a detour: its card opens beside the film instead.
  else void detour('card', lead.poi.id, lead.poi.title, at, () => carnet.onOpenCard(lead.poi));
};

/** Clicked elsewhere on the globe (a point, a territory, a person…): the path played waits, the carnet folds. */
const elsewhere = () => carnet.pause();

const SCENARIO_POLL_MS = 3000;
const SCENARIO_WAIT_MS = 180_000;
/** The latest walk asked of the AI wins: a life, or a detour. */
let writeToken = 0;
/** "de Napoléon", "d’Edward". */
const of = (name: string) => (/^[aeiouyàâéèêëîïôöùûü]/i.test(name) ? `d’${name}` : `de ${name}`);

/** A walk written by an AI (a life, a detour): polled while it is, then played. */
async function writeWalk(url: string, note: string, fail: string, play: (w: ScenarioWalk) => void, instead?: () => void): Promise<void> {
  if (!filters.scenarios) return;
  const token = ++writeToken;
  const key = `walk:${token}`;
  const started = performance.now();
  carnet.setNote(note);
  try {
    for (;;) {
      let res: PersonScenarioResponse;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        res = (await r.json()) as PersonScenarioResponse;
      } catch {
        res = { status: 'none', walk: null };
      }
      if (token !== writeToken || !filters.scenarios) return;
      if (res.walk) {
        library.add([res.walk]);
        play(res.walk);
        return;
      }
      if (res.status !== 'pending' || performance.now() - started > SCENARIO_WAIT_MS) {
        carnet.setNote(res.status === 'no-ai' ? 'Aucune IA disponible pour écrire ce chemin pour le moment.' : fail);
        instead?.();
        window.setTimeout(() => token === writeToken && carnet.setNote(null), 6000);
        return;
      }
      setActivity(key, { label: 'IA · chemin', title: note, ai: true });
      await new Promise((r) => setTimeout(r, SCENARIO_POLL_MS));
    }
  } finally {
    setActivity(key, null);
  }
}

/** The step being written (the latest asked wins). */
let stepToken = 0;
const STEP_WAIT_MS = 90_000;

/** A card's scenario step as the server asks it: the scenario, the stop, the walk's stops in order. */
function stepUrl(walk: ScenarioWalk, j: number, prefetch: boolean): string | null {
  const st = walk.steps[j];
  if (!walk.from || st?.stop === undefined) return null;
  const params = viewParams();
  params.set('card', walk.from.id);
  params.set('title', walk.title.slice(0, 120));
  params.set('premise', walk.premise.slice(0, 300));
  if (walk.hero) params.set('hero', walk.hero.qid);
  params.set('invented', walk.invented ? '1' : '0');
  params.set('stop', String(st.stop));
  params.set('walk', walk.steps.flatMap((s) => (s.stop === undefined ? [] : [s.stop])).join(','));
  if (prefetch) params.set('prefetch', '1');
  return `/api/step?${params}`;
}

/** A step's text, written by an AI when the visitor gets there; the next one is asked ahead. */
async function writeStep(walk: ScenarioWalk, j: number): Promise<void> {
  const url = stepUrl(walk, j, false);
  if (!url) return;
  const token = ++stepToken;
  const key = `step:${token}`;
  const started = performance.now();
  try {
    for (;;) {
      let res: StepResponse;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        res = (await r.json()) as StepResponse;
      } catch {
        res = { status: 'none', text: null, cast: [], choices: [], facts: [], quote: null, gallery: [], near: [] };
      }
      if (token !== stepToken) return;
      if (res.text) {
        carnet.setStepText(walk.id, j, { text: res.text, cast: res.cast, choices: res.choices, facts: res.facts, quote: res.quote, gallery: res.gallery, near: res.near });
        // The next step, written while this one is read.
        const next = stepUrl(carnet.playing?.walk ?? walk, j + 1, true);
        if (next && !walk.steps[j + 1]?.text) void fetch(next).catch(() => undefined);
        return;
      }
      if (res.status !== 'pending' || performance.now() - started > STEP_WAIT_MS) {
        carnet.setNote(res.status === 'no-ai' ? 'Aucune IA disponible pour écrire cette étape pour le moment.' : 'Cette étape n’a pas pu être écrite. « relancer » pour réessayer.');
        window.setTimeout(() => token === stepToken && carnet.setNote(null), 6000);
        return;
      }
      setActivity(key, { label: 'IA · étape', title: `L’IA écrit l’étape « ${walk.steps[j]!.place} »`, ai: true });
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    setActivity(key, null);
  }
}

/** A card's doors that make a step's crossroads: what happened meanwhile, what led there. */
const doorCache = new Map<string, Promise<StepDoors>>();
function doorsOf(poi: PoiLite): Promise<StepDoors> {
  const known = doorCache.get(poi.id);
  if (known) return known;
  const run = (async () => {
    const started = performance.now();
    for (;;) {
      const r = await fetch(`/api/poi/${encodeURIComponent(poi.id)}/doors`).then((x) => (x.ok ? (x.json() as Promise<DoorsResponse>) : null)).catch(() => null);
      const pick = (k: 'meanwhile' | 'cause' | 'effect') => r?.doors.find((d) => d.kind === k) ?? null;
      const settled = !r || !r.pending.some((k) => k === 'meanwhile' || k === 'cause' || k === 'effect');
      if (settled || performance.now() - started > 30_000) return { meanwhile: pick('meanwhile'), cause: pick('cause'), effect: pick('effect') };
      await new Promise((x) => setTimeout(x, 2000));
    }
  })();
  doorCache.set(poi.id, run);
  return run;
}

/** A real person's life as a path across the cards they appear in; `branch`: hung on the path played. */
function lifeScenario(h: { qid: string; name: string }, branch: boolean): Promise<void> {
  return writeWalk(
    `/api/people/${encodeURIComponent(h.qid)}/scenario?${viewParams()}`,
    `L’IA écrit l’histoire ${of(h.name)} à travers les fiches de sa vie…`,
    `Pas assez de lieux connus dans la vie ${of(h.name)} pour en faire un chemin.`,
    (w) => carnet.play(w, 0, branch && carnet.playing ? 'branch' : undefined),
  );
}

/** A short detour off the path played: a person's moments, or a place's story, around the step's year. */
function detour(kind: DetourKind, id: string, name: string, at: LeadFrom, instead?: () => void): Promise<void> {
  const year = at.year;
  const params = viewParams();
  params.set('kind', kind);
  params.set('id', id);
  params.set('year', String(Math.round(year)));
  params.set('from', (at.walk?.title ?? name).slice(0, 120));
  // A person's detour goes elsewhere than the story branched from, when their life allows.
  if (at.walk?.from) params.set('card', at.walk.from.id);
  return writeWalk(
    `/api/detour?${params}`,
    kind === 'person' ? `L’IA écrit un détour avec ${name} autour de ${formatYear(Math.round(year))}…` : `L’IA écrit un détour par ${name} autour de ${formatYear(Math.round(year))}…`,
    kind === 'person' ? `Pas assez de moments connus ${of(name)} autour de cette date pour un détour.` : `Pas assez de lieux autour de cette date pour un détour par « ${name} » : voici sa fiche.`,
    (w) => carnet.play(w, 0, 'detour'),
    instead,
  );
}

/** The paths through a place's card, in the carnet: its story read, then its scenarios written. */
let placeToken = 0;
async function placePaths(poi: PoiLite): Promise<void> {
  const token = ++placeToken;
  const show = (walks: ScenarioWalk[], status: Here['status']) => cardHere({ poi, walks, status });
  carnet.showHere(show([], filters.scenarios ? 'pending' : 'none'));
  if (!filters.scenarios) return;
  const started = performance.now();
  const get = async <T>(url: string): Promise<T | null> => {
    try {
      const r = await fetch(url);
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const key = `place:${token}`;
  let found: ScenarioWalk[] = [];
  try {
    while (performance.now() - started < SCENARIO_WAIT_MS) {
      if (token !== placeToken || carnet.hereKey !== poi.id) return;
      // The story first: scenarios are written over its stops.
      const story = await get<StoryResponse>(`/api/poi/${encodeURIComponent(poi.id)}/story`);
      if (story?.story) {
        const res = await get<ScenariosResponse>(`/api/poi/${encodeURIComponent(poi.id)}/scenarios?${viewParams()}`);
        if (token !== placeToken) return;
        if (res?.scenarios.length) {
          found = res.scenarios.map((sc) => walkOf(poi, res.story ?? story.story!, sc));
          library.add(found);
          carnet.updateHere(show(found, res.more ? 'pending' : 'ready'));
          if (!res.more) return;
        } else if (!res || res.status !== 'pending') return carnet.updateHere(show([], res?.status ?? 'none'));
      } else if (!story || story.status !== 'pending') return carnet.updateHere(show([], story?.status ?? 'none'));
      setActivity(key, { label: 'IA · chemins', title: `L’IA trace les chemins de « ${poi.title} »`, ai: true });
      await new Promise((r) => setTimeout(r, SCENARIO_POLL_MS));
    }
    carnet.updateHere(show(found, found.length ? 'ready' : 'none'));
  } finally {
    setActivity(key, null);
  }
}

// ---------- search bar ----------
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
new SearchBox(document.getElementById('search')!, {
  territories: (q) => {
    const want = fold(q);
    const seen = new Set<string>();
    return borders.shapes
      .filter((s) => s.parent === null && s.name)
      .sort((a, b) => b.km2 - a.km2)
      .flatMap((s) => {
        const key = realmKey(s);
        const label = borders.displayName(s.name);
        if (seen.has(key) || !(fold(label).includes(want) || fold(s.name).includes(want))) return [];
        seen.add(key);
        return [{ key, label }];
      })
      .slice(0, 4);
  },
  scenarios: (q) => library.search(q),
  scenariosOn: () => filters.scenarios,
}, {
  card: (p) => {
    elsewhere();
    travel(p);
  },
  person: (h) => {
    elsewhere();
    playSound('person');
    people.follow(h);
  },
  personScenario: (h) => void lifeScenario(h, false),
  territory: (t) => {
    elsewhere();
    const realm = borders.realmByKey(t.key);
    if (!realm) return;
    selectTerritory(realm);
    const a = borders.territoryArea(t.key);
    if (a) viewer.camera.flyTo({ destination: Rectangle.fromDegrees(a.west, a.south, a.east, a.north), duration: 1.6 });
  },
  scenario: (w) => {
    const known = carnet.pathOf(w.id);
    carnet.play(w, known && !known.done ? known.step : 0);
  },
});

/** Shows a point's card; the camera only moves on click, not on hover. */
function showPoi(id: string): void {
  elsewhere();
  clearTerritory();
  pois.select(id);
  if (card.currentPoi !== id) void card.open(id);
}

/** Going through a door (or back along the trail): the globe flies there while the timeline glides to its date. */
function travel(p: PoiLite): void {
  elsewhere();
  playSound(p.category);
  clearTerritory();
  pois.upsert([p]);
  pois.select(p.id);
  timeline.glideTo(p.date_start);
  pois.flyTo(p, { journey: true });
  void card.open(p.id);
}

// ---------- live search over WebSocket ----------
let online = false;
let pending = 0;
let ai = 0;
/**
 * Discreet: nothing when idle, a dot and a short word while points or details
 * are looked up, an hourglass while an AI reads (the zone, a card's doors,
 * the Monde vivant flows).
 */
function renderStatus(): void {
  setActivity('zone-ai', online && ai > 0 ? { label: 'IA · faits de la zone', title: 'L’IA cherche d’autres faits sur cette zone', ai: true } : null);
  setActivity('zone', online && pending > 0 ? { label: 'Points de la zone', title: 'Recherche de points sur cette zone', ai: false } : null);
}
function showActivity(): void {
  if (!online) return timeline.setStatus('offline', 'Hors ligne, reconnexion…');
  const a = currentActivity();
  if (!a) return timeline.setStatus('idle', '', '');
  const more = a.more ? ` (+${a.more})` : '';
  timeline.setStatus(a.ai ? 'ai' : 'busy', a.label + more, a.title);
}
onActivity(showActivity);
const conn = new Connection({
  onState: (s) => {
    online = s === 'open';
    renderStatus();
    showActivity();
  },
  onMessage: (msg) => {
    if (msg.type === 'pois') {
      pois.upsert(msg.pois, { quiet: msg.background });
      filters.setCounts(pois.inWindow());
    } else if (msg.type === 'status') {
      pending = msg.pending;
      ai = msg.ai ?? 0;
      renderStatus();
    }
  },
});

// Searches start once the camera and timeline have been still for a moment (brief §5.2).
let searchTimer: number | undefined;
function scheduleSearch(): void {
  // Playing: the timeline never stops, so points are asked for along the way (once a second).
  if (timeline.playing) {
    if (searchTimer === undefined) searchTimer = window.setTimeout(() => {
      searchTimer = undefined;
      sendView();
    }, 1_000);
    return;
  }
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = undefined;
    sendView();
  }, 450);
}
function sendView(): void {
  const rect = viewRect(viewer);
  const res = resolutionForArea(rectAreaKm2(rect));
  const cells = cellsForRect(rect, res).slice(0, 64);
  const { tStart, tEnd } = timeline.window;
  const view: ViewMessage = { type: 'view', res, cells, tStart, tEnd, filter: 'all' };
  conn.sendView(view);
  startIdle(view);
}

// ---------- while the viewer stays still: loading around, enriching here ----------
// Step 0 asks for the view to be enriched (web + AI, in the background);
// then rings of places around it (close views), or periods before and
// after it (far views), farther at each step. Points found are kept in
// memory, ready when the viewer goes there. Any move starts over.
const IDLE_START_MS = 2_500;
const IDLE_STEP_MS = 4_000;
const MAX_RING = 8;
/** Far views search the whole world per period: fewer steps, they are costly. */
const MAX_RING_GLOBAL = 4;
let idleTimer: number | undefined;
let idleView: ViewMessage | null = null;
let ring = 0;
function startIdle(view: ViewMessage): void {
  clearTimeout(idleTimer);
  idleView = view;
  ring = 0;
  idleTimer = window.setTimeout(idleStep, IDLE_START_MS);
}
function stopIdle(): void {
  clearTimeout(idleTimer);
  idleView = null;
}
function idleStep(): void {
  const v = idleView;
  if (!v) return;
  // Hidden tab or offline: wait, without losing the ring reached.
  if (document.hidden || !online) {
    idleTimer = window.setTimeout(idleStep, IDLE_STEP_MS);
    return;
  }
  let next: Omit<ViewMessage, 'type'> | null = { res: v.res, cells: v.cells, tStart: v.tStart, tEnd: v.tEnd, filter: v.filter };
  if (ring > 0 && isGlobalSearchRes(v.res)) {
    // Far view: the periods on each side, one window further at each step.
    const width = v.tEnd - v.tStart + 1;
    const k = Math.ceil(ring / 2);
    const tStart = ring % 2 ? v.tEnd + 1 + (k - 1) * width : v.tStart - k * width;
    const t0 = Math.max(MIN_YEAR, tStart);
    const t1 = Math.min(MAX_YEAR, tStart + width - 1);
    next = t0 <= t1 ? { ...next, tStart: t0, tEnd: t1 } : null;
  } else if (ring > 0) {
    const cells = ringAround(v.cells, ring).slice(0, 64);
    next = cells.length ? { ...next, cells } : null;
  }
  if (next && !conn.sendPrefetch({ type: 'prefetch', ring, ...next })) {
    idleTimer = window.setTimeout(idleStep, IDLE_STEP_MS);
    return;
  }
  ring++;
  if (ring <= (isGlobalSearchRes(v.res) ? MAX_RING_GLOBAL : MAX_RING)) idleTimer = window.setTimeout(idleStep, IDLE_STEP_MS);
}
viewer.camera.moveStart.addEventListener(stopIdle);
viewer.camera.changed.addEventListener(() => {
  borders.setCameraHeight(viewer.camera.positionCartographic.height);
  applyZoom();
});
viewer.camera.percentageChanged = 0.05;
viewer.camera.moveEnd.addEventListener(() => {
  save({ camera: cameraState(viewer) });
  scheduleSearch();
});

// ---------- picking ----------
const tooltip = document.getElementById('tooltip')!;
const handler = viewer.screenSpaceEventHandler;
// Picking renders the scene into an offscreen buffer: do it at most once per
// frame, and not at all while a mouse button drags the globe.
let dragging = false;
let hoverAt: Cartesian2 | null = null;
// Resting on a point opens its card (hover intent: passing over it does not),
// when turned on in the Réglages page.
const HOVER_OPEN_MS = 350;
let hoverOpen = false;
let hoverPoi: string | null = null;
let hoverTimer: number | undefined;
function hover(): void {
  const at = hoverAt;
  hoverAt = null;
  if (!at || dragging) return;
  const figure = people.pick(at);
  if (figure) {
    viewer.canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = `${at.x}px`;
    tooltip.style.top = `${at.y}px`;
    tooltip.innerHTML = '<div class="tooltip-title"></div><div class="tooltip-meta"></div>';
    tooltip.firstElementChild!.textContent = figure.kind === 'person' ? figure.journey.name : `Armée : ${figure.army.side}`;
    tooltip.lastElementChild!.textContent = figure.presence.text;
    return;
  }
  const walked = storyMap.pickStep(at);
  if (walked) {
    viewer.canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = `${at.x}px`;
    tooltip.style.top = `${at.y}px`;
    tooltip.innerHTML = '<div class="tooltip-title"></div><div class="tooltip-meta"></div>';
    tooltip.firstElementChild!.textContent = `${walked.j + 1}. ${walked.step.place}`;
    tooltip.lastElementChild!.textContent = `${walked.step.label} · ${formatYear(walked.step.year)}`;
    return;
  }
  const stop = storyMap.pick(at);
  if (stop) {
    viewer.canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = `${at.x}px`;
    tooltip.style.top = `${at.y}px`;
    tooltip.innerHTML = '<div class="tooltip-title"></div><div class="tooltip-meta"></div>';
    tooltip.firstElementChild!.textContent = stop.poi?.title ?? stop.name;
    tooltip.lastElementChild!.textContent = `${stop.label} · ${formatYear(stop.year)}${stop.poi ? ' · ⤷ entrer dans son histoire' : ''}`;
    return;
  }
  const alive = livingAt(at);
  if (alive) {
    viewer.canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = `${at.x}px`;
    tooltip.style.top = `${at.y}px`;
    tooltip.innerHTML = '<div class="tooltip-title"></div><div class="tooltip-meta"></div>';
    tooltip.firstElementChild!.textContent = alive.title;
    tooltip.lastElementChild!.textContent = alive.meta;
    return;
  }
  const { poi, cluster } = pois.pick(at);
  viewer.canvas.style.cursor = poi || cluster ? 'pointer' : '';
  if ((poi?.id ?? null) !== hoverPoi) {
    hoverPoi = poi?.id ?? null;
    clearTimeout(hoverTimer);
    if (poi && hoverOpen && card.currentPoi !== poi.id) {
      hoverTimer = window.setTimeout(() => {
        if (hoverPoi !== poi.id || dragging) return;
        tooltip.hidden = true;
        showPoi(poi.id);
      }, HOVER_OPEN_MS);
    }
  }
  if (poi && card.currentPoi === poi.id) tooltip.hidden = true;
  else if (poi) {
    tooltip.hidden = false;
    tooltip.style.left = `${at.x}px`;
    tooltip.style.top = `${at.y}px`;
    tooltip.innerHTML = `<div class="tooltip-title"></div><div class="tooltip-meta"></div>`;
    tooltip.firstElementChild!.textContent = poi.title;
    tooltip.lastElementChild!.textContent =
      `${formatPoiDate(poi.date_start, poi.date_end, poi.date_precision)} · ${CATEGORY_LABELS[poi.category]}`;
  } else tooltip.hidden = true;
}
viewer.canvas.addEventListener('pointerdown', () => {
  dragging = true;
  tooltip.hidden = true;
  clearTimeout(hoverTimer);
});
viewer.canvas.addEventListener('pointerleave', () => {
  hoverPoi = null;
  clearTimeout(hoverTimer);
  tooltip.hidden = true;
});
window.addEventListener('pointerup', () => (dragging = false));
handler.setInputAction((m: { endPosition: Cartesian2 }) => {
  if (dragging) return;
  if (!hoverAt) requestAnimationFrame(hover);
  hoverAt = Cartesian2.clone(m.endPosition);
}, ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction((c: { position: Cartesian2 }) => {
  const figure = people.pick(c.position);
  if (figure) {
    tooltip.hidden = true;
    openFigure(figure);
    return;
  }
  const alive = living.pick(c.position);
  if (alive) {
    tooltip.hidden = true;
    openLiving(alive);
    return;
  }
  const walked = storyMap.pickStep(c.position);
  if (walked) {
    tooltip.hidden = true;
    carnet.showStep(walked.j);
    return;
  }
  const stop = storyMap.pick(c.position);
  if (stop) {
    tooltip.hidden = true;
    card.onStoryStop(stop, true);
    return;
  }
  const { poi, cluster } = pois.pick(c.position);
  clearTimeout(hoverTimer);
  if (poi) {
    tooltip.hidden = true;
    playSound(poi.category);
    showPoi(poi.id);
    pois.flyTo(poi);
  } else if (cluster) {
    // Zoom onto the cluster's members.
    const pts = (cluster as Entity[]).map((e) => e.position!.getValue(viewer.clock.currentTime)!).filter(Boolean);
    const sphere = BoundingSphere.fromPoints(pts);
    viewer.camera.flyToBoundingSphere(sphere, { duration: 1.4 });
  } else {
    clickTerritory(c.position);
  }
}, ScreenSpaceEventType.LEFT_CLICK);

/** A click on land outlines the territory and opens its card (kingdom, ruler at that date). */
/** A short note at the cursor, reusing the tooltip. */
function flashHint(at: Cartesian2, text: string): void {
  tooltip.hidden = false;
  tooltip.style.left = `${at.x}px`;
  tooltip.style.top = `${at.y}px`;
  tooltip.innerHTML = '<div class="tooltip-meta"></div>';
  tooltip.firstElementChild!.textContent = text;
  window.setTimeout(() => (tooltip.hidden = true), 2000);
}

// ---------- territories: realm, then its vassals and provinces, then theirs ----------

interface Place {
  key: string;
  label: string;
  /** English name for the era (card lookup when there is no item). */
  name: string;
  area: Area;
  qid: Promise<string | null> | string | null;
  /** Border feature: its members are its regions, with their real borders. */
  featureId: number | null;
}
/** Selected chain: a realm of the map, then regions picked inside it. */
let path: Place[] = [];
/** divisions[i]: the regions of path[i] (only the deepest level is drawn). */
let divisions: Region[][] = [];
let dividing = 0;
/** Estimated regions already computed (a split is not redone at each click). */
const divided = new Map<string, Region[]>();

const HINT_TERRITORY = 'Cliquez à nouveau dans le territoire pour le découper en provinces.';
const HINT_REGION = 'Cliquez à nouveau dans la région pour la découper à son tour.';
const midYear = () => Math.round((timeline.window.tStart + timeline.window.tEnd) / 2);
const isQid = (q: string | null | undefined): q is string => !!q && /^Q\d+$/.test(q);

function clearTerritory(): void {
  dividing++;
  path = [];
  divisions = [];
  borders.showRegions(null);
  borders.highlight(null);
}

/**
 * The period shown changed (the timeline plays, or was moved): the selected
 * territory keeps its outline with its new borders, its vassals and
 * provinces are drawn again as they are now. Estimated regions (from the
 * seats of a year) fold back; a realm that no longer exists lets go.
 */
function followTerritory(): void {
  const top = path[0];
  if (!top) return;
  const realm = borders.realmByKey(top.key);
  if (!realm) {
    if (divisions.length) backToTerritory();
    return;
  }
  top.featureId = realm.id;
  top.area = borders.territoryArea(top.key) ?? top.area;
  if (!divisions.length) return;
  const real = divisions[0]!.every((r) => !r.estimated && r.featureId != null);
  const members = real ? memberRegions(realm.id) : [];
  if (members.length < 2) {
    backToTerritory();
    return;
  }
  dividing++;
  divisions = [members];
  path = path.slice(0, 1);
  borders.showRegions(members, top.key);
  borders.highlight(top.key);
}

/** Folds the regions back: only the territory stays outlined. */
function backToTerritory(): void {
  dividing++;
  divisions = [];
  path = path.slice(0, 1);
  borders.showRegions(null);
  if (path[0]) borders.highlight(path[0].key);
  card.setHint(HINT_TERRITORY);
}

/**
 * A click on land: a realm is outlined and its card opens; a second click
 * inside it splits it into its vassals and provinces, and so on one level down.
 */
function clickTerritory(position: Cartesian2): void {
  // No terrain: the ellipsoid is the ground, and it needs no rendered tile.
  const hit = viewer.camera.pickEllipsoid(position);
  const c = hit ? Cartographic.fromCartesian(hit) : null;
  const lon = c ? CesiumMath.toDegrees(c.longitude) : 0;
  const lat = c ? CesiumMath.toDegrees(c.latitude) : 0;
  // Inside drawn regions (deepest level first).
  for (let i = c ? divisions.length - 1 : -1; i >= 0; i--) {
    const region = divisions[i]!.find((r) => contains(r, lon, lat));
    if (!region) continue;
    if (path[i + 1]?.key === region.qid && path.length === i + 2) void splitPlace(i + 1, position);
    else selectRegion(i, region);
    return;
  }
  const realm = c ? borders.realmAt(lon, lat) : null;
  if (realm) elsewhere();
  if (!realm) {
    // Sea or unclaimed land: a territory card closes, a point's card stays.
    if (card.currentPoi === null) card.close();
    if (hit) flashHint(position, 'Zone sans nom dans la carte historique');
    return;
  }
  const key = realmKey(realm);
  if (path[0]?.key === key) {
    if (divisions.length === 0 && path.length === 1) void splitPlace(0, position);
    else {
      // In the territory but outside its regions: back to the whole.
      backToTerritory();
      const p = path[0];
      void card.openPolity(realm.qid ? { qid: realm.qid, name: realm.name } : { name: realm.name }, p.label, midYear(), HINT_TERRITORY, 'territory');
    }
    return;
  }
  selectTerritory(realm);
}

function selectTerritory(realm: BorderShape): void {
  elsewhere();
  dividing++;
  playSound('territory');
  pois.select(null);
  borders.showRegions(null);
  const key = realmKey(realm);
  borders.highlight(key);
  const label = borders.displayName(realm.name);
  const info = card.openPolity(realm.qid ? { qid: realm.qid, name: realm.name } : { name: realm.name }, label, midYear(), HINT_TERRITORY, 'territory');
  // The server refreshes this realm first: its colors are asked again shortly.
  borders.freshenSoon();
  path = [{
    key, label, name: realm.name, area: borders.territoryArea(key)!, featureId: realm.id,
    // The card checks the item against the era: its answer is the one to split.
    qid: info.then((i) => i?.qid ?? realm.qid),
  }];
  divisions = [];
}

function selectRegion(level: number, region: Region): void {
  elsewhere();
  dividing++;
  playSound('territory');
  pois.select(null);
  const deeper = divisions.length > level + 1;
  path = [...path.slice(0, level + 1), {
    key: region.qid, label: region.label, name: region.name ?? region.label, area: region,
    qid: isQid(region.qid) ? region.qid : null, featureId: region.featureId ?? null,
  }];
  divisions = divisions.slice(0, level + 1);
  if (deeper) borders.showRegions(divisions[level]!); // back up from a deeper level
  borders.outline(region);
  const target = isQid(region.qid)
    ? { qid: region.qid, ...(region.estimated ? {} : { name: region.name ?? region.label }) }
    : { name: region.name ?? region.label };
  void card.openPolity(target, region.label, midYear(), HINT_REGION, region.estimated ? 'estimated' : 'member');
}

/** Members of a composite realm, as regions with their real borders. */
function memberRegions(featureId: number): Region[] {
  const parent = borders.shapes.find((s) => s.id === featureId);
  return borders.members(featureId)
    .filter((m) => m.name && m.rings.length)
    .map((m) => {
      let label = borders.displayName(m.name);
      // The realm's own lands, next to its vassals.
      if (parent && ((m.qid && m.qid === parent.qid) || m.name === parent.name)) label = `${label} (domaine propre)`;
      return {
        ...bounds(m.rings), qid: m.qid ?? `f:${m.id}`, label, kind: null, name: m.name,
        lat: (m.south + m.north) / 2, lon: (m.west + m.east) / 2, estimated: false, featureId: m.id,
      };
    });
}

function showDivision(level: number, regions: Region[], hint: string): void {
  const fresh = divisions.length !== level + 1;
  divisions = [...divisions.slice(0, level), regions];
  path = path.slice(0, level + 1);
  borders.showRegions(regions, path[0]?.key ?? null);
  if (fresh) playSound('polity');
  card.setHint(hint);
}

/**
 * Splits the selected place: into its members when the borders dataset has
 * them (real borders, already loaded), else between the seats of its
 * Wikidata regions (estimated limits).
 */
async function splitPlace(level: number, at: Cartesian2): Promise<void> {
  const place = path[level]!;
  const token = ++dividing;
  // The realm's feature follows the period shown.
  const featureId = level === 0 ? (borders.realmByKey(place.key)?.id ?? null) : place.featureId;
  if (featureId !== null) {
    const members = memberRegions(featureId);
    if (members.length >= 2) {
      showDivision(level, members, `${members.length} vassaux et provinces, frontières historiques de l’époque. Cliquez sur l’un d’eux pour sa fiche.`);
      return;
    }
  }
  card.setHint('Recherche des provinces dans Wikidata…');
  const qid = await place.qid;
  if (token !== dividing) return;
  if (!qid) {
    card.setHint(null);
    flashHint(at, 'Territoire sans fiche Wikidata : pas de découpage possible');
    return;
  }
  const year = midYear();
  const apply = (res: SubdivisionsResponse) => {
    if (token !== dividing) return;
    const area = level === 0 ? (borders.territoryArea(place.key) ?? place.area) : place.area;
    const memo = `${qid}|${year}|${res.items.map((i) => i.qid).join(',')}|${area.west},${area.south},${area.east},${area.north}`;
    let regions = divided.get(memo);
    if (!regions) {
      regions = divide(area, res.items);
      divided.set(memo, regions);
      if (divided.size > 200) divided.delete(divided.keys().next().value!);
    }
    if (regions.length < 2) {
      card.setHint('Aucune subdivision connue dans Wikidata à cette date.');
      return;
    }
    showDivision(level, regions, `${regions.length} régions aux limites estimées d’après leurs chefs-lieux. Cliquez sur l’une d’elles pour sa fiche.`);
  };
  try {
    await fetchCached<SubdivisionsResponse>(`/api/polity/subdivisions?${new URLSearchParams({ qid, year: String(year) })}`, apply);
  } catch {
    if (token === dividing) card.setHint('Wikidata ne répond pas pour le moment : réessayez dans un instant.');
  }
}

// Cesium's default double-click tracks entities: not wanted here.
handler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// ---------- start ----------
renderStatus();
// Preferences are set in the Réglages page: re-read when coming back to the globe.
const applyUi = async () => {
  const ui = await loadUiSettings();
  if (ui) hoverOpen = ui.hoverOpen;
};
void applyUi();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void applyUi();
});
await borders.init();
borders.setCameraHeight(viewer.camera.positionCartographic.height);
const w = timeline.window;
void borders.setYear(Math.round((w.tStart + w.tEnd) / 2));
sendView();
