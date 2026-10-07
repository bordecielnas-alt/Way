import './cesium-base.ts';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/eb-garamond/500-italic.css';
import '@fontsource-variable/inter';
import './style.css';

import { ScreenSpaceEventType, Cartesian2, BoundingSphere, Cartesian3, Cartographic, Math as CesiumMath, Rectangle, type Entity } from 'cesium';
import {
  cellsForRect, formatPoiDate, formatWhen, formatYear, isGlobalSearchRes, MAX_YEAR, MIN_YEAR, rectAreaKm2, resolutionForArea, ringAround, CATEGORY_LABELS,
  ALL_THEMES, THEMES, walkOf, type Backdrop, type Category, type DetourKind, type PersonScenarioResponse, type PoiLite, type ScenarioWalk,
  type ScenariosResponse, type StepResponse, type Story, type StoryPerson, type StoryResponse, type SubdivisionsResponse,
  type ThemeFilter, type ViewMessage,
} from '@way/shared';
import { aiActivity, currentActivity, onActivity, setActivity } from './activity.ts';
import { BordersLayer, realmKey, type BorderShape } from './borders.ts';
import { CameraGuide, type Zone } from './camera.ts';
import { Card, type CardPaths } from './card.ts';
import { Connection } from './connection.ts';
import { bounds, contains, divide, type Area, type Region } from './divisions.ts';
import { Filters, importanceFloor, type Heraldry, type Scale } from './filters.ts';
import { GeographyLayer, NO_GEOGRAPHY, type Geography } from './geography.ts';
import { formatPop, LivingLayer, NO_LIVING, type Living, type LivingPick } from './living.ts';
import { cameraState, createGlobe, restoreCamera, setBasemap, setPaper, viewRect, type Basemap, type CameraState } from './globe.ts';
import { PoiLayer } from './markers.ts';
import { PeopleLayer, type Picked } from './people.ts';
import { Player, ScenarioLibrary, stepDecisions, type Here, type LeadFrom, type ThreadAt } from './scenario.ts';
import { SearchBox } from './search.ts';
import { StoryLayer } from './storymap.ts';
import { EntityMenu } from './entity.ts';
import { fetchCached } from './localcache.ts';
import { loadUiSettings, playSound } from './sounds.ts';
import { Timeline, type TimeWindow } from './timeline.ts';
import { resizable, watchBars, type Resizable } from './layout.ts';

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

/** The part of the map the panels leave visible: where the camera brings the places it goes to. */
function mapZone(): Zone {
  const canvas = viewer.scene.canvas;
  const [w, h] = [canvas.clientWidth, canvas.clientHeight];
  const box = (el: Element | null) => {
    if (!(el instanceof HTMLElement) || el.hidden) return null;
    const css = getComputedStyle(el);
    if (css.display === 'none' || css.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? r : null;
  };
  const phone = w <= 640;
  const scenario = box(document.querySelector('#scenario .sc-card'));
  const card = box(document.getElementById('card'));
  // The scenario's card on the left (folded, its player lies low on the left: the map stays whole above it);
  // on a phone, it is a sheet over the bottom, and a card covers all of the map.
  const left = !phone && scenario && document.body.classList.contains('sc-open') ? scenario.right : 0;
  const right = phone ? w : Math.min(w, card?.left ?? w);
  const top = box(document.querySelector('.topbar'))?.bottom ?? 0;
  const bottom = Math.min(h, box(document.getElementById('timeline'))?.top ?? h, phone ? scenario?.top ?? h : h);
  return { left: left + 8, top: top + 8, right: right - 8, bottom: bottom - 8 };
}
const camera = new CameraGuide(viewer, mapZone);

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
    if (at) camera.to(at, { min: 300_000, max: 4_000_000 });
  }, 400);
};

function openFigure(f: Picked): void {
  elsewhere();
  clearTerritory();
  pois.select(null);
  const goTo = (year: number, lat: number | null, lon: number | null) => {
    timeline.glideTo(year);
    if (lat !== null && lon !== null) camera.to({ lat, lon }, { min: 300_000, max: 4_000_000 });
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
    camera.to(s, { min: 500_000, max: 5_000_000 });
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
    }
    player.setEnabled(on);
  },
);
// The people followed: a menu of the bar too.
filters.addMenu(document.getElementById('people')!);
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
/** Set once the player exists: a card closed, "Lire en entier" says so. */
let cardClosed = (): void => undefined;
const card = new Card(
  document.getElementById('card')!,
  () => {
    pois.select(null);
    clearTerritory();
    cardClosed();
  },
  travel,
);
// The open card's story on the globe: its places, doors into their own stories.
const storyMap = new StoryLayer(viewer);
/** The story of the card shown, drawn again when no path plays (a path draws its own steps). */
let shownStory: Story | null = null;
card.onStory = (shown) => {
  shownStory = shown?.story ?? null;
  if (player.playing && !player.isPaused) return;
  if (shownStory) storyMap.show(shownStory);
  else storyMap.clear();
};
const storyBack = () => (shownStory ? storyMap.show(shownStory) : storyMap.clear());

/** A stop of a card's story: there, at the story's moment (a port's own card would take the timeline to its founding). */
card.onStoryStop = (s, openCard) => {
  elsewhere();
  clearTerritory();
  timeline.glideTo(s.year);
  camera.to(s, { min: 100_000, max: 2_500_000 });
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

// ---------- scenarios: the scenario's card on the left, its player at its foot, its file ----------
const library = new ScenarioLibrary();
const player = new Player(document.getElementById('scenario')!, () => library.all);
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
player.setEnabled(filters.scenarios);
card.pathsThrough = (poi) => library.through({ poi });
player.onMet = (w) => library.add([w]);

/** The paths through a card: its own scenarios, then those met elsewhere passing there. */
function cardHere(at: CardPaths): Here {
  const ids = new Set(at.walks.map((w) => w.id));
  return { key: at.poi.id, title: at.poi.title, poi: at.poi, status: at.status, walks: [...at.walks, ...library.through({ poi: at.poi }).filter((w) => !ids.has(w.id))] };
}
const personHere = (p: StoryPerson): Here => ({ key: p.qid, title: p.name, person: p, status: 'ready', walks: library.through({ qid: p.qid }) });
/** A walk read: from where it was left when it was started before. */
function readWalk(w: ScenarioWalk): void {
  const known = player.progressOf(w.id);
  player.start(w, known && !known.done ? known.step : 0);
}
card.onPaths = (at) => player.showHere(cardHere(at));
card.onPathsChanged = (at) => {
  library.add(at.walks);
  player.updateHere(cardHere(at));
};
card.onPersonPaths = (p) => player.showHere(personHere(p));
card.onPlay = readWalk;
card.pathState = (id) => player.progressOf(id);
card.onThread = (kind, poi) => void threadWalk(kind, { poi, year: poi.date_start, lat: poi.lat, lon: poi.lon });
card.queueAt = (poi) => player.placeIn(poi.id);
card.onQueueAdd = (poi) => player.add(poi);
card.onQueueGo = (i) => {
  player.goTo(i);
  player.unfold();
};
/** The card on the right opened by the visitor (not only following the steps). */
let cardAsked = false;
// While the file plays, the AI writes its steps first: a card's own paths wait for the card to be asked.
card.waitRoles = () => !!player.playing && !player.isPaused && !cardAsked;
cardClosed = () => {
  cardAsked = false;
  player.refresh();
};

player.onChange = () => card.syncScenario(player.playing?.walk ?? null);
player.onMarks = (marks) => timeline.setMarks(marks);
timeline.onMark = (i) => player.goTo(i);
player.refresh(); // the file kept from a previous visit, on the timeline

// The two cards between the bars, each as wide as the visitor made it; the globe keeps its share.
watchBars(document.querySelector<HTMLElement>('.topbar')!, timelineEl);
const showing = (cls: string) => document.body.classList.contains(cls);
const scenarioWidth: Resizable = resizable({
  grip: document.querySelector<HTMLElement>('.grip-scenario')!, side: 'left', cssVar: '--sc-w', key: 'orbis:width-scenario',
  def: 400, min: 320, max: 680, other: () => (showing('card-open') ? cardWidth.width : 0),
});
const cardWidth: Resizable = resizable({
  grip: document.querySelector<HTMLElement>('.grip-card')!, side: 'right', cssVar: '--card-w', key: 'orbis:width-card',
  def: 420, min: 340, max: 680, other: () => (showing('sc-open') ? scenarioWidth.width : 0),
});
const fitCards = () => {
  scenarioWidth.fit();
  cardWidth.fit();
};
fitCards();
// A card opened or closed beside the other: both make room for the globe again.
new MutationObserver(fitCards).observe(document.body, { attributes: true, attributeFilter: ['class'] });
player.onRoute = (now, prev, next) => storyMap.showWalk(now, prev, next);
player.onPin = (step, label, paused) => storyMap.setPin(step, label, paused);
player.onStep = (walk, j, first) => {
  const step = walk.steps[j]!;
  clearTerritory();
  playSound(step.poi?.category ?? 'person');
  timeline.glideTo(step.when ?? step.year);
  // Once the player is laid out: a walk started is framed whole, then the map moves only when a step leaves the view.
  requestAnimationFrame(() => {
    if (first) {
      camera.resetHeight();
      camera.frame(walk.steps, { min: 250_000, max: 7_000_000 }, step);
    } else camera.to(step, { min: 150_000, max: 4_000_000 });
  });
};
// The scenario's pin stays on the map: the card's story comes back around it.
player.onPause = storyBack;
/** A card asked for (a place's paths, an entity's menu): it opens on the right, the file waits. */
function openCard(poi: PoiLite): void {
  player.pause();
  clearTerritory();
  pois.upsert([poi]);
  pois.select(poi.id);
  cardAsked = true;
  void card.open(poi.id).then(() => player.refresh());
}
player.onOpenCard = openCard;
player.onThread = (kind, at) => void threadWalk(kind, at);
player.onNeedText = (walk, j) => void writeStep(walk, j);

// A name to act on, wherever it shows (a ruler, a person of a story, a link of a card's text, someone at a step).
const entities = new EntityMenu();
entities.onFollow = (p) => {
  elsewhere();
  playSound('person');
  people.follow({ qid: p.qid, name: p.name, description: p.role, born: p.born, died: p.died, image: p.image });
};
entities.onPersonPaths = (p) => player.showHere(personHere(p));
entities.onLife = (p) => void lifeScenario(p);
entities.onOpenCard = openCard;
entities.onPlacePaths = (poi) => void placePaths(poi);
entities.onFlyTo = (lat, lon) => camera.to({ lat, lon }, { min: 50_000, max: 2_000_000, force: true });
card.onEntity = (el, e) => entities.show(el, e);
player.onEntity = (el, e) => entities.show(el, e);
player.onLead = (lead, how, at) => {
  if (lead.kind === 'person') {
    if (how === 'full') void lifeScenario(lead.person);
    else void detour('person', lead.person.qid, lead.person.name, at);
  } else if (how === 'full') void placePaths(lead.poi);
  // A card too thin for a crochet: its card opens instead.
  else void detour('card', lead.poi.id, lead.poi.title, at, () => openCard(lead.poi));
};

/** Clicked elsewhere on the globe (a point, a territory, a person…): the file waits where it is, the camera is the visitor's. */
const elsewhere = () => player.pause();

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
  player.setNote(note);
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
        player.setNote(res.status === 'no-ai' ? 'Aucune IA disponible pour écrire ce chemin pour le moment.' : fail);
        instead?.();
        window.setTimeout(() => token === writeToken && player.setNote(null), 6000);
        return;
      }
      if (res.ai) player.setNote(note.replace(/^L’IA/, res.ai));
      setActivity(key, aiActivity('chemin', note, res.ai));
      await new Promise((r) => setTimeout(r, SCENARIO_POLL_MS));
    }
  } finally {
    setActivity(key, null);
  }
}

/** The step being written (the latest asked wins). */
let stepToken = 0;
const STEP_WAIT_MS = 90_000;

/**
 * A step as the server asks it: a card's scenario (the stop, the walk's stops
 * in order), or a real person's life (the place, the steps around it), each
 * written from its Wikipedia article.
 */
function stepUrl(walk: ScenarioWalk, j: number, prefetch: boolean): string | null {
  const st = walk.steps[j];
  if (!st) return null;
  const params = viewParams();
  params.set('title', walk.title.slice(0, 120));
  params.set('premise', walk.premise.slice(0, 300));
  if (st.beat) params.set('beat', st.beat.slice(0, 120));
  for (const d of stepDecisions(walk, j)) params.append('chose', d.slice(0, 120));
  if (prefetch) params.set('prefetch', '1');
  if (walk.from && st.stop !== undefined) {
    params.set('card', walk.from.id);
    if (walk.hero) params.set('hero', walk.hero.qid);
    params.set('invented', walk.invented ? '1' : '0');
    params.set('stop', String(st.stop));
    // The stops lived before a turning point's walk come first: the writer picks up from them.
    params.set('walk', [...(walk.prelude ?? []), ...walk.steps.flatMap((s) => (s.stop === undefined ? [] : [s.stop]))].join(','));
    for (const f of st.forks ?? []) if (f.steps[0]?.stop !== undefined) params.append('fork', `${f.steps[0].stop}:${f.label}`.slice(0, 140));
    return `/api/step?${params}`;
  }
  // A place across the centuries, the world at one moment: from each card's own article.
  const thread = walk.thread;
  if ((thread === 'place' || thread === 'era') && st.poi) {
    params.set('card', st.poi.id);
    params.set('thread', thread);
    params.set('label', st.label.slice(0, 120));
    for (const s of walk.steps.slice(Math.max(0, j - 6), j)) params.append('lived', `${formatWhen(s)} ${s.place} (${s.label})`.slice(0, 200));
    const next = walk.steps[j + 1];
    if (next) params.set('next', `${formatWhen(next)} · ${next.label} · ${next.place}`.slice(0, 200));
    return `/api/card-step?${params}`;
  }
  // A life (or a detour in one): from the article of the person followed.
  if (!walk.hero) return null;
  params.set('person', walk.hero.qid);
  params.set('place', st.place.slice(0, 200));
  params.set('label', st.label.slice(0, 120));
  params.set('year', String(Math.round(st.year)));
  params.set('lat', String(st.lat));
  params.set('lon', String(st.lon));
  if (st.poi) params.set('poi', st.poi.id);
  for (const s of walk.steps.slice(Math.max(0, j - 6), j)) params.append('lived', `${formatWhen(s)} ${s.place} (${s.label})`.slice(0, 200));
  const next = walk.steps[j + 1];
  if (next) params.set('next', `${formatWhen(next)} · ${next.label} · ${next.place}`.slice(0, 200));
  return `/api/life-step?${params}`;
}

/** A step's text, written by an AI when the visitor gets there; the next one is asked ahead. */
async function writeStep(walk: ScenarioWalk, j: number): Promise<void> {
  const url = stepUrl(walk, j, false);
  if (!url) return;
  // A life's step comes with a few lines: made a full one quietly, kept as is when it cannot be.
  const had = !!walk.steps[j]?.text;
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
        res = { status: 'none', text: null, recit: null, cast: [], choices: [], next: null, facts: [], quote: null, gallery: [], near: [], sources: [], ai: null };
      }
      if (token !== stepToken) return;
      if (res.text) {
        player.setStepText(walk.id, j, {
          text: res.text, recit: res.recit ?? null, cast: res.cast, choices: res.choices, next: res.next, facts: res.facts, quote: res.quote, gallery: res.gallery, near: res.near,
          sources: res.sources ?? [], ai: res.ai ?? null,
        });
        // The next step of the file, written while this one is read.
        const up = player.upcoming;
        const next = up && !up.walk.steps[up.step]?.ai ? stepUrl(up.walk, up.step, true) : null;
        if (next) void fetch(next).catch(() => undefined);
        return;
      }
      if (res.status !== 'pending' || performance.now() - started > STEP_WAIT_MS) {
        player.setWriter(null);
        if (had) return;
        player.setNote(res.status === 'no-ai' ? 'Aucune IA disponible pour écrire cette étape pour le moment.' : 'Cette étape n’a pas pu être écrite. « relancer » pour réessayer.');
        window.setTimeout(() => token === stepToken && player.setNote(null), 6000);
        return;
      }
      player.setWriter(res.ai ?? 'L’IA');
      setActivity(key, aiActivity('étape', `Écriture de l’étape « ${walk.steps[j]!.place} » d’après Wikipédia`, res.ai));
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    setActivity(key, null);
  }
}

/** A real person's life as a path across the cards they appear in: another route, what came next set aside. */
function lifeScenario(h: { qid: string; name: string }): Promise<void> {
  return writeWalk(
    `/api/people/${encodeURIComponent(h.qid)}/scenario?${viewParams()}`,
    `L’IA trace la vie ${of(h.name)} à travers les fiches où elle passe…`,
    `Pas assez de lieux connus dans la vie ${of(h.name)} pour en faire un chemin.`,
    (w) => player.start(w),
  );
}

/** A crochet off the step now: a person's moments, or a place's story, around the step's year, slipped in after it. */
function detour(kind: DetourKind, id: string, name: string, at: LeadFrom, instead?: () => void): Promise<void> {
  const year = at.year;
  const params = viewParams();
  params.set('kind', kind);
  params.set('id', id);
  params.set('year', String(Math.round(year)));
  params.set('from', (at.walk?.title ?? name).slice(0, 120));
  const asked = player.cursor;
  // A person's detour goes elsewhere than the story branched from, when their life allows.
  if (at.walk?.from) params.set('card', at.walk.from.id);
  return writeWalk(
    `/api/detour?${params}`,
    kind === 'person' ? `L’IA écrit un crochet avec ${name} autour de ${formatYear(Math.round(year))}…` : `L’IA écrit un crochet par ${name} autour de ${formatYear(Math.round(year))}…`,
    kind === 'person' ? `Pas assez de moments connus ${of(name)} autour de cette date pour un crochet.` : `Pas assez de lieux autour de cette date pour un crochet par « ${name} » : voici sa fiche.`,
    (w) => player.crochet(w, asked),
    instead,
  );
}

/**
 * A walk made of cards: a place across the centuries, or the world at one
 * moment (a theme per step, starting near the visitor): what came next is set aside.
 */
function threadWalk(kind: 'place' | 'era', at: ThreadAt): Promise<void> {
  const params = viewParams();
  params.set('year', String(Math.round(at.year)));
  params.set('lat', at.lat.toFixed(3));
  params.set('lon', at.lon.toFixed(3));
  const url = kind === 'place' && at.poi ? `/api/poi/${encodeURIComponent(at.poi.id)}/across-time` : `/api/era?${params}`;
  const name = at.poi?.title ?? 'ce lieu';
  return writeWalk(
    url,
    kind === 'place' ? `Recherche des moments de ${name} à travers les siècles…` : `Recherche du monde vers ${formatYear(Math.round(at.year))}, un thème par étape…`,
    kind === 'place' ? `Pas assez de moments connus autour de ${name} pour en faire un chemin.` : `Pas assez de fiches connues vers ${formatYear(Math.round(at.year))} pour en faire un chemin.`,
    (w) => player.start(w),
  );
}

/** The paths through a place's card, above the player: its story read, then its scenarios written. */
let placeToken = 0;
async function placePaths(poi: PoiLite): Promise<void> {
  const token = ++placeToken;
  const show = (walks: ScenarioWalk[], status: Here['status']) => cardHere({ poi, walks, status });
  player.showHere(show([], filters.scenarios ? 'pending' : 'none'));
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
      if (token !== placeToken || player.hereKey !== poi.id) return;
      // The story first: scenarios are written over its stops.
      const story = await get<StoryResponse>(`/api/poi/${encodeURIComponent(poi.id)}/story`);
      let working = story?.ai;
      if (story?.story) {
        const res = await get<ScenariosResponse>(`/api/poi/${encodeURIComponent(poi.id)}/scenarios?${viewParams()}`);
        if (token !== placeToken) return;
        working = res?.ai ?? working;
        if (res?.scenarios.length) {
          found = res.scenarios.map((sc) => walkOf(poi, res.story ?? story.story!, sc));
          library.add(found);
          player.updateHere(show(found, res.more ? 'pending' : 'ready'));
          if (!res.more) return;
        } else if (!res || res.status !== 'pending') return player.updateHere(show([], res?.status ?? 'none'));
      } else if (!story || story.status !== 'pending') return player.updateHere(show([], story?.status ?? 'none'));
      setActivity(key, aiActivity('chemins', `Tracé des chemins de « ${poi.title} »`, working));
      await new Promise((r) => setTimeout(r, SCENARIO_POLL_MS));
    }
    player.updateHere(show(found, found.length ? 'ready' : 'none'));
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
  personScenario: (h) => void lifeScenario(h),
  territory: (t) => {
    elsewhere();
    const realm = borders.realmByKey(t.key);
    if (!realm) return;
    selectTerritory(realm);
    const a = borders.territoryArea(t.key);
    if (a) viewer.camera.flyTo({ destination: Rectangle.fromDegrees(a.west, a.south, a.east, a.north), duration: 1.6 });
  },
  scenario: (w) => {
    readWalk(w);
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
  camera.to(p, { min: 80_000, max: 2_500_000 });
  void card.open(p.id);
}

// ---------- live search over WebSocket ----------
let online = false;
let pending = 0;
let ai = 0;
/** The AI reading the zone's searches, as the server names it. */
let aiModel: string | null = null;
/**
 * Discreet: nothing when idle, a dot and a short word while points or details
 * are looked up, an hourglass while an AI reads (the zone, a card's doors,
 * the Monde vivant flows).
 */
function renderStatus(): void {
  setActivity('zone-ai', online && ai > 0 ? aiActivity('faits de la zone', 'Recherche d’autres faits sur cette zone, sur le web', aiModel) : null);
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
      aiModel = msg.model ?? null;
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
  // The scenario's pin, or a step beside it: where a click takes the file.
  const pin = storyMap.pickPin(at);
  const side = pin ? null : storyMap.pickStep(at);
  const walked = pin ?? (side ? storyMap.besideStep(side) : null);
  if (walked) {
    viewer.canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = `${at.x}px`;
    tooltip.style.top = `${at.y}px`;
    tooltip.innerHTML = '<div class="tooltip-title"></div><div class="tooltip-meta"></div>';
    tooltip.firstElementChild!.textContent = walked.place;
    tooltip.lastElementChild!.textContent = `${formatYear(walked.year)} · ${pin ? 'revenir au scénario' : side === 1 ? 'l’étape suivante' : 'l’étape précédente'}`;
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
  if (storyMap.pickPin(c.position)) {
    tooltip.hidden = true;
    player.back();
    return;
  }
  const side = storyMap.pickStep(c.position);
  if (side) {
    tooltip.hidden = true;
    player.showStep(side);
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
    // Clicked, it shows: the camera only moves if the card now covers it.
    requestAnimationFrame(() => camera.to(poi));
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
