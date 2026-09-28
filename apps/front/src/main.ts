import './cesium-base.ts';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/eb-garamond/500-italic.css';
import '@fontsource-variable/inter';
import './style.css';

import { ScreenSpaceEventType, Cartesian2, BoundingSphere, Cartesian3, Cartographic, Math as CesiumMath, type Entity } from 'cesium';
import {
  cellsForRect, formatPoiDate, rectAreaKm2, resolutionForArea, CATEGORY_LABELS,
  type Category, type Door, type SubdivisionsResponse, type ViewMessage,
} from '@way/shared';
import { BordersLayer, realmKey, type BorderShape } from './borders.ts';
import { Card } from './card.ts';
import { Connection } from './connection.ts';
import { bounds, contains, divide, type Area, type Region } from './divisions.ts';
import { Filters, importanceFloor, type Heraldry, type Scale } from './filters.ts';
import { GeographyLayer, NO_GEOGRAPHY, type Geography } from './geography.ts';
import { cameraState, createGlobe, restoreCamera, setBasemap, viewRect, type Basemap, type CameraState } from './globe.ts';
import { PoiLayer } from './markers.ts';
import { PeopleLayer, type Picked } from './people.ts';
import { fetchCached } from './localcache.ts';
import { loadUiSettings, playSound } from './sounds.ts';
import { Timeline, type TimeWindow } from './timeline.ts';

// ---------- persisted per-viewer preferences ----------
interface Saved {
  camera?: CameraState; window?: TimeWindow; hidden?: Category[]; basemap?: Basemap; scale?: Scale; heraldry?: Heraldry; geography?: Geography;
}
const STORAGE_KEY = 'way:state';
function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Saved;
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

// ---------- timeline & borders ----------
const timelineEl = document.getElementById('timeline')!;
let bordersTimer: number | undefined;
const timeline = new Timeline(timelineEl, saved.window ?? { tStart: -500, tEnd: -300 }, (w, moment) => {
  pois.setWindow(w.tStart, w.tEnd);
  people.setWindow(moment.tStart, moment.tEnd);
  filters.setCounts(pois.countsInWindow());
  clearTimeout(bordersTimer);
  bordersTimer = window.setTimeout(() => borders.setYear(Math.round((w.tStart + w.tEnd) / 2)), 250);
  // Regions are those of a year: moving in time folds them back into the territory.
  if (divisions.length) backToTerritory();
  save({ window: moment });
  scheduleSearch();
});
const borders = new BordersLayer(viewer, (t) => timeline.setBordersNote(t));
// Armies wear the colors of their country on the map.
people.colorOf = (qid, name) => borders.colorOf(qid, name);
borders.onPeriod = () => people.refresh();
pois.setWindow(timeline.window.tStart, timeline.window.tEnd);
people.setWindow(timeline.moment.tStart, timeline.moment.tEnd);

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

// ---------- filters ----------
const filters = new Filters(
  document.getElementById('filters')!,
  saved.hidden ?? [],
  (hidden) => {
    pois.setHidden(hidden);
    save({ hidden: [...hidden] });
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
  },
  { ...NO_GEOGRAPHY, ...saved.geography },
  (g) => {
    save({ geography: g });
    geography.set(g);
  },
);
geography.set(filters.geography);
borders.setHeraldry(filters.heraldry.territories);
people.setHeraldry(filters.heraldry.armies);
pois.setHidden(filters.hiddenSet);

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

/** Shows a point's card; the camera only moves on click, not on hover. */
function showPoi(id: string): void {
  clearTerritory();
  pois.select(id);
  if (card.currentPoi !== id) void card.open(id);
}

/** Going through a door: the globe flies there while the timeline glides to its date. */
function travel(door: Door): void {
  const p = door.poi;
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
function renderStatus(): void {
  if (!online) timeline.setStatus('offline', 'Hors ligne, reconnexion…');
  else if (pending > 0) timeline.setStatus('busy', `Exploration de ${pending} zone${pending > 1 ? 's' : ''}…`);
  else timeline.setStatus('idle', 'Zone explorée');
}
const conn = new Connection({
  onState: (s) => {
    online = s === 'open';
    renderStatus();
  },
  onMessage: (msg) => {
    if (msg.type === 'pois') {
      pois.upsert(msg.pois);
      filters.setCounts(pois.countsInWindow());
    } else if (msg.type === 'status') {
      pending = msg.pending;
      renderStatus();
    }
  },
});

// Searches start once the camera and timeline have been still for a moment (brief §5.2).
let searchTimer: number | undefined;
function scheduleSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(sendView, 450);
}
function sendView(): void {
  const rect = viewRect(viewer);
  const res = resolutionForArea(rectAreaKm2(rect));
  const cells = cellsForRect(rect, res).slice(0, 64);
  const { tStart, tEnd } = timeline.window;
  const view: ViewMessage = { type: 'view', res, cells, tStart, tEnd, filter: 'all' };
  conn.sendView(view);
}
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
  dividing++;
  playSound('territory');
  pois.select(null);
  borders.showRegions(null);
  const key = realmKey(realm);
  borders.highlight(key);
  const label = borders.displayName(realm.name);
  const info = card.openPolity(realm.qid ? { qid: realm.qid, name: realm.name } : { name: realm.name }, label, midYear(), HINT_TERRITORY, 'territory');
  path = [{
    key, label, name: realm.name, area: borders.territoryArea(key)!, featureId: realm.id,
    // The card checks the item against the era: its answer is the one to split.
    qid: info.then((i) => i?.qid ?? realm.qid),
  }];
  divisions = [];
}

function selectRegion(level: number, region: Region): void {
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
