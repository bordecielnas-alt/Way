import './cesium-base.ts';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/eb-garamond/500-italic.css';
import '@fontsource-variable/inter';
import './style.css';

import { ScreenSpaceEventType, Cartesian2, BoundingSphere, Cartesian3, type Entity } from 'cesium';
import {
  cellsForRect, formatPoiDate, rectAreaKm2, resolutionForArea, CATEGORY_LABELS,
  type Category, type ViewMessage,
} from '@way/shared';
import { BordersLayer } from './borders.ts';
import { Card } from './card.ts';
import { Connection } from './connection.ts';
import { Filters } from './filters.ts';
import { cameraState, createGlobe, restoreCamera, setBasemap, viewRect, type Basemap, type CameraState } from './globe.ts';
import { PoiLayer } from './markers.ts';
import { Timeline, type TimeWindow } from './timeline.ts';

// ---------- persisted per-viewer preferences ----------
interface Saved { camera?: CameraState; window?: TimeWindow; hidden?: Category[]; basemap?: Basemap }
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

const pois = new PoiLayer(viewer);

// ---------- timeline & borders ----------
const timelineEl = document.getElementById('timeline')!;
let bordersTimer: number | undefined;
const timeline = new Timeline(timelineEl, saved.window ?? { tStart: -500, tEnd: -300 }, (w) => {
  pois.setWindow(w.tStart, w.tEnd);
  filters.setCounts(pois.countsInWindow());
  clearTimeout(bordersTimer);
  bordersTimer = window.setTimeout(() => borders.setYear(Math.round((w.tStart + w.tEnd) / 2)), 250);
  save({ window: w });
  scheduleSearch();
});
const borders = new BordersLayer(viewer, (t) => timeline.setBordersNote(t));
pois.setWindow(timeline.window.tStart, timeline.window.tEnd);

// ---------- filters ----------
const filters = new Filters(document.getElementById('filters')!, saved.hidden ?? [], (hidden) => {
  pois.setHidden(hidden);
  save({ hidden: [...hidden] });
});
pois.setHidden(filters.hiddenSet);

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
const card = new Card(document.getElementById('card')!, () => pois.select(null));

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

// Searches start once the camera and timeline have been still for ~800 ms (brief §5.2).
let searchTimer: number | undefined;
function scheduleSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(sendView, 800);
}
function sendView(): void {
  const rect = viewRect(viewer);
  const res = resolutionForArea(rectAreaKm2(rect));
  const cells = cellsForRect(rect, res).slice(0, 64);
  const { tStart, tEnd } = timeline.window;
  const view: ViewMessage = { type: 'view', res, cells, tStart, tEnd, filter: 'all' };
  conn.sendView(view);
}
viewer.camera.changed.addEventListener(() => borders.setCameraHeight(viewer.camera.positionCartographic.height));
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
function hover(): void {
  const at = hoverAt;
  hoverAt = null;
  if (!at || dragging) return;
  const { poi, cluster } = pois.pick(at);
  viewer.canvas.style.cursor = poi || cluster ? 'pointer' : '';
  if (poi) {
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
});
window.addEventListener('pointerup', () => (dragging = false));
handler.setInputAction((m: { endPosition: Cartesian2 }) => {
  if (dragging) return;
  if (!hoverAt) requestAnimationFrame(hover);
  hoverAt = Cartesian2.clone(m.endPosition);
}, ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction((c: { position: Cartesian2 }) => {
  const { poi, cluster } = pois.pick(c.position);
  if (poi) {
    tooltip.hidden = true;
    pois.select(poi.id);
    pois.flyTo(poi);
    void card.open(poi.id);
  } else if (cluster) {
    // Zoom onto the cluster's members.
    const pts = (cluster as Entity[]).map((e) => e.position!.getValue(viewer.clock.currentTime)!).filter(Boolean);
    const sphere = BoundingSphere.fromPoints(pts);
    viewer.camera.flyToBoundingSphere(sphere, { duration: 1.4 });
  }
}, ScreenSpaceEventType.LEFT_CLICK);
// Cesium's default double-click tracks entities: not wanted here.
handler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// ---------- start ----------
renderStatus();
await borders.init();
borders.setCameraHeight(viewer.camera.positionCartographic.height);
const w = timeline.window;
void borders.setYear(Math.round((w.tStart + w.tEnd) / 2));
sendView();
