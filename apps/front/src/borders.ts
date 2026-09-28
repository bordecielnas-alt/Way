import {
  Event as CesiumEvent, GeographicTilingScheme, ImageryLayer, Math as CesiumMath, Rectangle,
  type ImageryProvider, type Viewer,
} from 'cesium';
import {
  formatYear, type Backdrop, type BordersIndex, type BordersPeriod, type Emblem, type EmblemsResponse, type Faith, type FaithsResponse, type PolityLabels,
} from '@way/shared';
import { bounds, type Area, type Region, type Ring } from './divisions.ts';
import { letter, nameRoots, shortName, type Lettering } from './lettering.ts';
import { commonsImage, loadImage } from './media.ts';
import { dominantColor, lighter, withAlpha } from './tint.ts';

/**
 * Dominant colors of emblem files, kept by the browser: known colors show at
 * once next time. Versioned: a change in how colors are measured measures them again.
 */
const TINTS_KEY = 'orbis:tints:v2';
function loadTints(): Map<string, string | null> {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(TINTS_KEY) ?? '{}') as Record<string, string | null>));
  } catch {
    return new Map();
  }
}
function saveTints(tints: Map<string, string | null>): void {
  try {
    // The most recent ones, should the list grow very long.
    localStorage.setItem(TINTS_KEY, JSON.stringify(Object.fromEntries([...tints].slice(-3000))));
  } catch {
    /* not remembered: computed again next time */
  }
}

/** Dominant color of an image, read from a small copy. */
function tintOf(img: HTMLImageElement): string | null {
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 40, 40);
  try {
    return dominantColor(g.getImageData(0, 0, 40, 40).data);
  } catch {
    return null; // a cross-origin image taints the canvas
  }
}

/** A realm, or a member drawn inside a composite realm, for the period shown. */
export interface BorderShape extends Area {
  id: number;
  /** English name for that era. */
  name: string;
  qid: string | null;
  parent: number | null;
  /** Topmost realm it belongs to (itself for a realm). */
  root: number;
  km2: number;
  /** Largest outer ring: where the name is written. */
  main: Ring | null;
}

interface Drawn extends Area {
  fill: string;
  stroke: string;
  /** Members: inner lines only, no fill. */
  inner?: boolean;
  dashed?: boolean;
}

interface Named { text: Lettering; style: 'realm' | 'region' }

/**
 * A coat of arms (or flag) in watermark over a whole realm: centered at
 * lon/lat, half its size in degrees of latitude, clipped to the realm's rings.
 */
interface Mark extends Area { img: HTMLCanvasElement; lon: number; lat: number; hw: number; hh: number; boxes: Area[] }

const TILE = 256;
type Style = 'normal' | 'highlight' | 'regions';
const FADE_MS = 700;
/** Fade between periods when they follow each other quickly (play mode). */
const QUICK_FADE_MS = 220;
/** Longest wait for new border tiles to be painted before the old ones go anyway. */
const SETTLE_MAX_MS = 1500;
/** Main-thread time spent drawing border tiles per frame, so panning stays smooth. */
const FRAME_BUDGET_MS = 6;
const PERIOD_CACHE = 24;
const REALM_FONT = '600 100px "EB Garamond", Georgia, serif';
const REGION_FONT = 'italic 500 100px "EB Garamond", Georgia, serif';

function hue(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

/** Religious backdrop: one color per faith family. */
export const FAITH_COLORS: Record<Faith, string> = {
  christianity: '#5b8fd9',
  islam: '#3fae6a',
  judaism: '#8fd0f0',
  zoroastrianism: '#e0a040',
  hinduism: '#e8733a',
  buddhism: '#f0cf50',
  jainism: '#c9a0e8',
  sikhism: '#e05a8a',
  chinese: '#d24a3c',
  shinto: '#f09a9a',
  ancient: '#a08466',
  other: '#9a9a9a',
};

/** Realms are recognized across periods by their Wikidata item, else by name. */
export const realmKey = (s: { qid: string | null; name: string }) => s.qid ?? `n:${s.name}`;

// ---------- frame-budgeted drawing queue shared by all border layers ----------
const queue: (() => void)[] = [];
let scheduled = false;
let onDrained: (() => void) | null = null;
function enqueue(task: () => void): void {
  queue.push(task);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(function run() {
    const start = performance.now();
    while (queue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) queue.shift()!();
    onDrained?.();
    if (queue.length > 0) requestAnimationFrame(run);
    else scheduled = false;
  });
}

// ---------- letter widths, measured once per font ----------
const measurer = document.createElement('canvas').getContext('2d')!;
const widthCache = new Map<string, number>();
function measure(font: string, tracking: number) {
  return (ch: string) => {
    const k = `${font}|${ch}`;
    let w = widthCache.get(k);
    if (w === undefined) {
      measurer.font = font;
      w = measurer.measureText(ch).width / 100;
      widthCache.set(k, w);
    }
    return w + tracking;
  };
}

/** Watermark strength by its height on screen (under the realm's color): gone when too small, fainter when blown up. */
function markAlpha(px: number): number {
  if (px < 40) return 0;
  return 0.28 * Math.min(1, (px - 40) / 60) * (px > 3000 ? Math.max(0.4, 1 - (px - 3000) / 6000) : 1);
}

/** Color of a realm on the map, solid (for its armies): same hue as its borders. */
function realmColor(h: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = 0.48 - 0.5 * 0.48 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** An emblem that fades out toward its edges, so it melts into the realm. */
const fadedCache = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
function faded(img: HTMLImageElement): HTMLCanvasElement {
  let c = fadedCache.get(img);
  if (c) return c;
  const w0 = img.naturalWidth || 256;
  const h0 = img.naturalHeight || w0;
  const k = 400 / Math.max(w0, h0);
  c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.setTransform(c.width / 2, 0, 0, c.height / 2, c.width / 2, c.height / 2);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.4, 'rgba(0,0,0,0.9)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.4)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(-1, -1, 2, 2);
  fadedCache.set(img, c);
  return c;
}

/** Removes a layer, and drops the tiles it still had waiting to be drawn. */
function drop(viewer: Viewer, layer: ImageryLayer): void {
  (layer.imageryProvider as unknown as BordersTiles).retired = true;
  viewer.imageryLayers.remove(layer, true);
}

/** Name fades in once its letters are readable, and out when they grow bigger than the screen needs. */
function nameAlpha(px: number, style: Named['style']): number {
  const lo = style === 'realm' ? 6 : 7;
  const hi = style === 'realm' ? 90 : 60;
  if (px < lo || px > hi * 1.8) return 0;
  return Math.min(1, (px - lo) / 5) * Math.min(1, (hi * 1.8 - px) / (hi * 0.8));
}

/**
 * Imagery provider that rasterizes borders tile by tile, at the tile's own
 * resolution: lines stay sharp at every zoom, and names are painted on the
 * map itself, bending with the realm and growing as the camera comes closer.
 */
class BordersTiles {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle: Rectangle;
  readonly tileWidth = TILE;
  readonly tileHeight = TILE;
  readonly maximumLevel = 14;
  readonly minimumLevel = 0;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new CesiumEvent();
  readonly credit = undefined;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  /** Set when its layer is gone: tiles still queued are skipped. */
  retired = false;

  constructor(private shapes: Drawn[], private style: Style = 'normal', private names: Named[] = [], private marks: Mark[] = []) {
    // A highlight or a territory's regions only cover that territory: Cesium then requests no other tile.
    if (style !== 'normal' && shapes.length) {
      const w = Math.min(...shapes.map((s) => s.west));
      const so = Math.min(...shapes.map((s) => s.south));
      const e = Math.max(...shapes.map((s) => s.east));
      const n = Math.max(...shapes.map((s) => s.north));
      this.rectangle = Rectangle.fromDegrees(Math.max(-180, w - 1), Math.max(-90, so - 1), Math.min(180, e + 1), Math.min(90, n + 1));
    } else this.rectangle = this.tilingScheme.rectangle;
  }

  getTileCredits(): undefined {
    return undefined;
  }

  pickFeatures(): undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    return new Promise((resolve) => enqueue(() => resolve(this.draw(x, y, level))));
  }

  private draw(x: number, y: number, level: number): HTMLCanvasElement {
    if (this.retired) {
      const empty = document.createElement('canvas');
      empty.width = empty.height = 1;
      return empty;
    }
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const west = CesiumMath.toDegrees(r.west);
    const east = CesiumMath.toDegrees(r.east);
    const south = CesiumMath.toDegrees(r.south);
    const north = CesiumMath.toDegrees(r.north);
    const sx = TILE / (east - west);
    const sy = TILE / (north - south);
    const hl = this.style === 'highlight';
    const pad = (hl ? 8 : 2) / sx; // strokes straddle the tile edge

    const canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
    const g = canvas.getContext('2d')!;
    g.lineJoin = 'round';
    for (const s of this.shapes) {
      if (s.east < west - pad || s.west > east + pad || s.north < south - pad || s.south > north + pad) continue;
      g.beginPath();
      for (const ring of s.rings) {
        let lx = NaN, ly = NaN;
        for (let i = 0; i < ring.length; i++) {
          const px = (ring[i]![0] - west) * sx;
          const py = (north - ring[i]![1]) * sy;
          if (i === 0) g.moveTo(px, py);
          // Skip sub-pixel steps: at world scale most vertices collapse.
          else if (Math.abs(px - lx) + Math.abs(py - ly) < 0.7) continue;
          else g.lineTo(px, py);
          lx = px;
          ly = py;
        }
        g.closePath();
      }
      if (hl) {
        // Outlined territory: light veil, glow, then a bright gold line.
        g.fillStyle = 'rgba(255, 226, 150, 0.16)';
        g.fill('evenodd');
        g.strokeStyle = 'rgba(255, 200, 100, 0.35)';
        g.lineWidth = 7;
        g.stroke();
        g.strokeStyle = '#ffe2a0';
        g.lineWidth = 2.2;
        g.stroke();
        continue;
      }
      if (!s.inner) {
        g.fillStyle = s.fill;
        g.fill('evenodd');
      }
      g.strokeStyle = s.stroke;
      g.setLineDash(s.dashed ? [5, 4] : []);
      g.lineWidth = s.inner ? 0.8 : s.dashed ? 1.4 : 1.2;
      g.stroke();
    }
    g.setLineDash([]);
    this.drawMarks(g, west, south, east, north, sx, sy);
    this.drawNames(g, west, south, east, north, sx, sy);
    return canvas;
  }

  private drawMarks(g: CanvasRenderingContext2D, west: number, south: number, east: number, north: number, sx: number, sy: number): void {
    for (const m of this.marks) {
      if (m.east < west || m.west > east || m.north < south || m.south > north) continue;
      const alpha = markAlpha(m.hh * 2 * sy);
      if (alpha <= 0.01) continue;
      const cos = Math.max(0.2, Math.cos((m.lat * Math.PI) / 180));
      if (m.lon + m.hw / cos < west || m.lon - m.hw / cos > east || m.lat + m.hh < south || m.lat - m.hh > north) continue;
      // Inside the realm only: its pieces in this tile make the clip.
      g.save();
      g.beginPath();
      m.rings.forEach((ring, k) => {
        const b = m.boxes[k]!;
        if (b.east < west || b.west > east || b.north < south || b.south > north) return;
        let lx = NaN, ly = NaN;
        for (let i = 0; i < ring.length; i++) {
          const px = (ring[i]![0] - west) * sx;
          const py = (north - ring[i]![1]) * sy;
          if (i === 0) g.moveTo(px, py);
          else if (Math.abs(px - lx) + Math.abs(py - ly) < 0.7) continue;
          else g.lineTo(px, py);
          lx = px;
          ly = py;
        }
        g.closePath();
      });
      g.clip('evenodd');
      g.globalAlpha = alpha;
      // Degrees of latitude as the unit both ways, as for the names: the emblem keeps its shape.
      g.setTransform(sx / cos, 0, 0, sy, (m.lon - west) * sx, (north - m.lat) * sy);
      g.drawImage(m.img, -m.hw, -m.hh, m.hw * 2, m.hh * 2);
      g.restore();
    }
  }

  private drawNames(g: CanvasRenderingContext2D, west: number, south: number, east: number, north: number, sx: number, sy: number): void {
    for (const { text, style } of this.names) {
      if (text.east < west || text.west > east || text.north < south || text.south > north) continue;
      const px = text.size * sy;
      const alpha = nameAlpha(px, style);
      if (alpha <= 0.02) continue;
      g.font = style === 'realm' ? REALM_FONT : REGION_FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.fillStyle = style === 'realm' ? `rgba(246, 236, 214, ${0.78 * alpha})` : `rgba(250, 242, 222, ${0.9 * alpha})`;
      g.strokeStyle = `rgba(20, 16, 12, ${0.5 * alpha})`;
      g.lineWidth = 9;
      const k = text.size / 100;
      for (const gl of text.glyphs) {
        const cos = Math.max(0.2, Math.cos((gl.lat * Math.PI) / 180));
        // Degrees of latitude as the unit both ways: a letter keeps its shape on the globe.
        g.setTransform(sx / cos, 0, 0, -sy, (gl.lon - west) * sx, (north - gl.lat) * sy);
        g.rotate(gl.angle);
        g.scale(k, -k);
        g.strokeText(gl.ch, 0, 0);
        g.fillText(gl.ch, 0, 0);
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}

interface Period extends BordersPeriod { shapes: BorderShape[] }

function decode(p: BordersPeriod, quantum: number): Period {
  const byId = new Map(p.features.map((f) => [f.id, f]));
  const rootOf = (id: number) => {
    let cur = byId.get(id)!;
    for (let i = 0; i < 8 && cur.parent !== null && byId.has(cur.parent); i++) cur = byId.get(cur.parent)!;
    return cur.id;
  };
  const shapes = p.features.map((f): BorderShape => {
    let main: Ring | null = null;
    let mainArea = 0;
    const rings: Ring[] = [];
    for (const poly of f.g) {
      poly.forEach((enc, i) => {
        const ring: Ring = [];
        let x = 0, y = 0;
        for (let j = 0; j + 1 < enc.length; j += 2) {
          x += enc[j]!;
          y += enc[j + 1]!;
          ring.push([x * quantum, y * quantum]);
        }
        rings.push(ring);
        if (i === 0) {
          const b = bounds([ring]);
          const a = (b.east - b.west) * (b.north - b.south);
          if (a > mainArea) { mainArea = a; main = ring; }
        }
      });
    }
    return {
      ...bounds(rings), id: f.id, name: f.name, qid: f.qid, parent: byId.has(f.parent ?? -1) ? f.parent : null,
      root: rootOf(f.id), km2: f.area, main,
    };
  });
  return { ...p, shapes };
}

function inside(s: Area, lon: number, lat: number): boolean {
  if (lon < s.west || lon > s.east || lat < s.south || lat > s.north) return false;
  let hit = false;
  for (const ring of s.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/**
 * Historical borders draped on the globe as an imagery layer: yearly
 * periods (Cliopatria), tiles drawn on demand, cross-fading when time moves.
 */
export class BordersLayer {
  private index: BordersIndex | null = null;
  private current: Period | null = null;
  private layer: ImageryLayer | null = null;
  private cache = new Map<number, Promise<Period>>();
  private alpha = 0.85;
  private fading = false;
  private fadeToken = 0;
  private lastFade = 0;
  /** The last borders layer fully painted: it stays under a replacement until that one is drawn. */
  private base: ImageryLayer | null = null;
  private settleWaiters: (() => void)[] = [];
  private wanted: number | null = null;
  private loadingPeriod = false;
  /** Names (or emblems to measure) that came while periods were being chained: drawn once the chain stops. */
  private namesDirty = false;
  private visible = true;
  private highlightLayer: ImageryLayer | null = null;
  private highlighted: string | null = null;
  private frNames: Record<string, string> = {};
  private regionsLayer: ImageryLayer | null = null;
  /** Realm split into regions: its own name gives way to theirs. */
  private quietRealm: string | null = null;
  private namesTimer: number | undefined;
  private letterings = new Map<string, Lettering | null>();
  /** Coats of arms in watermark (Blasons → Territoires). */
  private heraldry = false;
  private backdrop: Backdrop = 'political';
  /** Emblem file -> its dominant color (null: no real color). */
  private tints = loadTints();
  private tintTimer: number | undefined;
  private tintsSaveTimer: number | undefined;
  private faiths: Record<string, Faith> = {};
  private faithsFrom: number | null = null;
  private faithsTimer: number | undefined;
  private emblems: Record<string, Emblem> = {};
  private emblemsFrom: number | null = null;
  private emblemImages = new Map<string, HTMLImageElement | null>();
  private emblemsTimer: number | undefined;
  private redrawTimer: number | undefined;
  /** Each realm's watermark: centered behind the middle of its name, over all of its pieces. */
  private anchors: { key: string; qid: string | null; lon: number; lat: number; main: Area; area: Area }[] = [];
  /** Watermarks have their own layer, under the realms' colors: an emblem arriving redraws only them. */
  private marksLayer: ImageryLayer | null = null;

  /** Armies' colors found in the period shown (names change it too). */
  private colors = new Map<string, string>();
  /** Set by the app: the period shown changed (its colors with it). */
  onPeriod: () => void = () => undefined;

  constructor(private viewer: Viewer, private onNote: (text: string) => void) {
    onDrained = () => viewer.scene.requestRender();
  }

  async init(): Promise<void> {
    try {
      const r = await fetch('/api/borders/index');
      this.index = r.ok ? ((await r.json()) as BordersIndex) : null;
    } catch {
      this.index = null;
    }
    // Names are painted into tiles: the font must be there first.
    await Promise.all([document.fonts.load(REALM_FONT), document.fonts.load(REGION_FONT)]).catch(() => undefined);
    if (!this.index) {
      this.onNote('Frontières historiques indisponibles pour le moment…');
      setTimeout(async () => {
        await this.init();
        if (this.wanted != null) await this.setYear(this.wanted);
      }, 20_000);
    }
  }

  /** First year of the period containing `year` (borders constant until the next one). */
  private periodStart(year: number): number | null {
    const ev = this.index?.events;
    if (!ev?.length) return null;
    let pick = ev[0]!;
    for (const y of ev) {
      if (y > year) break;
      pick = y;
    }
    return pick;
  }

  private load(from: number): Promise<Period> {
    let p = this.cache.get(from);
    if (!p) {
      const { version, quantum } = this.index!;
      p = fetch(`/api/borders?${new URLSearchParams({ year: String(from), v: version })}`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<BordersPeriod>;
        })
        .then((raw) => decode(raw, quantum));
      p.catch(() => this.cache.delete(from));
      this.cache.set(from, p);
      if (this.cache.size > PERIOD_CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /**
   * Shows the borders of a year. While the timeline plays, loads are chained:
   * each period loaded is shown on the way (the map keeps up instead of
   * waiting for time to stop), then the latest one asked for is loaded.
   */
  async setYear(year: number): Promise<void> {
    this.wanted = year;
    if (this.loadingPeriod) return; // the load under way goes on to the latest year after
    this.loadingPeriod = true;
    try {
      for (;;) {
        const from = this.periodStart(this.wanted);
        if (from === null || from === this.current?.from) break;
        if (!(await this.showPeriod(from))) break; // unreachable: tried again at the next year asked
        // The next period waits for this one to be painted: the map follows as fast as it can draw.
        await this.settled();
      }
    } finally {
      this.loadingPeriod = false;
    }
    if (this.namesDirty) {
      this.namesDirty = false;
      this.show();
      this.onPeriod();
    }
  }

  private async showPeriod(from: number): Promise<boolean> {
    try {
      const period = await this.load(from);
      this.current = period;
      this.show();
      this.onPeriod();
      void this.loadNames(from);
      // Emblems give the realms their colors: asked for whatever the watermarks setting.
      void this.loadEmblems(from);
      if (this.backdrop === 'religion') void this.loadFaiths(from);
      this.onNote(`Frontières de ${formatYear(period.from)}${period.to > period.from ? ` à ${formatYear(period.to)}` : ''}`);
      // Playing forward: the next periods are fetched ahead.
      const ahead = this.index!.events.filter((y) => y > period.to).slice(0, 3);
      for (const y of ahead) void this.load(y).catch(() => undefined);
      return true;
    } catch (e) {
      console.warn('borders failed', e);
      return false;
    }
  }

  get shapes(): BorderShape[] {
    return this.current?.shapes ?? [];
  }

  /** The realm (top level) under a point, the smallest when realms overlap. */
  realmAt(lon: number, lat: number): BorderShape | null {
    let best: BorderShape | null = null;
    for (const s of this.shapes) {
      if (s.parent !== null || !s.name || (best && s.km2 >= best.km2)) continue;
      if (inside(s, lon, lat)) best = s;
    }
    return best;
  }

  realmByKey(key: string): BorderShape | null {
    return this.shapes.filter((s) => s.parent === null && realmKey(s) === key).sort((a, b) => b.km2 - a.km2)[0] ?? null;
  }

  /**
   * The solid color of a country on the map (for its armies): the realm with
   * that item, else that name, in the period shown; its own hue otherwise.
   */
  colorOf(qid: string | null, name: string): string {
    const memo = `${qid}|${name}`;
    const known = this.colors.get(memo);
    if (known) return known;
    let shape = qid ? this.shapes.find((s) => s.qid === qid) : undefined;
    if (!shape && name) {
      // By name: the same roots, in English or French ("France" and "Empire français"); the largest realm first.
      const want = nameRoots(name);
      const fits = (n: string) => {
        const has = nameRoots(n);
        return want.size > 0 && has.size > 0 && ([...want].every((w) => has.has(w)) || [...has].every((w) => want.has(w)));
      };
      shape = this.shapes
        .filter((s) => s.parent === null && s.name && (fits(s.name) || fits(this.displayName(s.name))))
        .sort((a, b) => b.km2 - a.km2)[0];
    }
    const root = shape ? (this.shapes.find((s) => s.id === shape.root) ?? shape) : null;
    const color = this.tintOf(root?.qid ?? qid) ?? realmColor(hue(root ? realmKey(root) : (qid ?? `n:${name}`)));
    this.colors.set(memo, color);
    return color;
  }

  /** Members drawn inside a composite realm (duchies, counties, the royal domain). */
  members(id: number): BorderShape[] {
    return this.shapes.filter((s) => s.parent === id);
  }

  /** French name for an era's name, when known. */
  displayName(name: string): string {
    return this.frNames[name] ?? name;
  }

  /** A realm as one area (all its pieces), by key, in the period shown. */
  territoryArea(key: string): Area | null {
    const parts = this.shapes.filter((s) => s.parent === null && realmKey(s) === key);
    if (!parts.length) return null;
    return bounds(parts.flatMap((p) => p.rings));
  }

  /** Outlines a realm by key (null clears). Kept across periods while the realm exists. */
  highlight(key: string | null): void {
    this.outline(key ? this.territoryArea(key) : null);
    this.highlighted = key;
  }

  /** Outlines any area (a region inside a territory); not kept across periods. */
  outline(area: Area | null): void {
    this.highlighted = null;
    if (this.highlightLayer) {
      drop(this.viewer, this.highlightLayer);
      this.highlightLayer = null;
    }
    if (area) {
      const merged: Drawn = { fill: '', stroke: '', ...area };
      const layer = new ImageryLayer(new BordersTiles([merged], 'highlight') as unknown as ImageryProvider, { alpha: 0 });
      layer.show = this.visible;
      this.viewer.imageryLayers.add(layer);
      this.highlightLayer = layer;
      const start = performance.now();
      const step = () => {
        if (this.highlightLayer !== layer) return;
        layer.alpha = Math.min(1, (performance.now() - start) / 350);
        this.viewer.scene.requestRender();
        if (layer.alpha < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    this.viewer.scene.requestRender();
  }

  /** Draws a territory's regions and their names (null clears); estimated limits are dashed. */
  showRegions(regions: Region[] | null, realm: string | null = null): void {
    if (this.regionsLayer) {
      drop(this.viewer, this.regionsLayer);
      this.regionsLayer = null;
    }
    const was = this.quietRealm;
    this.quietRealm = regions?.length ? realm : null;
    if (regions?.length) {
      const drawn: Drawn[] = regions.map((r) => ({
        ...r,
        // A vassal with a coat of arms of its own wears its color too.
        fill: ((t) => (t ? withAlpha(t, 0.3) : `hsla(${hue(r.qid)}, 45%, 60%, 0.24)`))(this.tintOf(r.qid)),
        stroke: r.estimated ? 'rgba(255, 240, 214, 0.8)' : 'rgba(255, 240, 214, 0.95)',
        dashed: r.estimated,
      }));
      const names: Named[] = [];
      for (const r of regions) {
        const ring = r.rings.reduce<Ring | null>((best, ring) => (!best || ring.length > best.length ? ring : best), null);
        const text = ring ? this.lettering(`r:${r.qid}:${r.label}`, ring, r.label, 'region') : null;
        if (text) names.push({ text, style: 'region' });
      }
      const layer = new ImageryLayer(new BordersTiles(drawn, 'regions', names) as unknown as ImageryProvider);
      layer.show = this.visible;
      this.viewer.imageryLayers.add(layer);
      this.regionsLayer = layer;
      // The outline stays above the regions.
      if (this.highlightLayer) this.viewer.imageryLayers.raiseToTop(this.highlightLayer);
    }
    // The realm's name under its regions would only get in the way: redrawn without it.
    if (was !== this.quietRealm) this.show();
    this.viewer.scene.requestRender();
  }

  private lettering(key: string, ring: Ring, text: string, style: Named['style']): Lettering | null {
    if (!this.letterings.has(key)) {
      const t = style === 'realm'
        ? letter(ring, shortName(text).toUpperCase(), measure(REALM_FONT, 0.2), { fill: 0.85 })
        : letter(ring, shortName(text), measure(REGION_FONT, 0.05), { fill: 0.8 });
      this.letterings.set(key, t);
      if (this.letterings.size > 4000) this.letterings.delete(this.letterings.keys().next().value!);
    }
    return this.letterings.get(key)!;
  }

  private show(): void {
    const period = this.current;
    if (!period) return;
    this.colors.clear();
    const drawn: Drawn[] = [];
    const names: Named[] = [];
    const anchors: typeof this.anchors = [];
    const marked = new Set<string>();
    // Big realms first: small ones inside or across them stay visible.
    const byId = new Map(period.shapes.map((s) => [s.id, s]));
    const ordered = [...period.shapes].sort((a, b) => (a.parent === null ? 0 : 1) - (b.parent === null ? 0 : 1) || b.km2 - a.km2);
    const religious = this.backdrop === 'religion';
    // No backdrop: the bare relief (a click still finds the realm under it).
    for (const s of this.backdrop === 'none' ? [] : ordered) {
      const root = byId.get(s.root) ?? s;
      const h = hue(realmKey(root));
      const named = !!s.name;
      // The realm wears the dominant color of its coat of arms (else of its flag), else a hue of its own.
      const tint = religious ? null : this.tintOf(root.qid);
      if (s.parent === null) {
        const faith = religious && s.qid ? this.faiths[s.qid] : undefined;
        drawn.push({
          ...s,
          fill: religious
            ? (faith ? `${FAITH_COLORS[faith]}66` : 'rgba(150, 150, 150, 0.10)')
            : tint ? withAlpha(tint, 0.34) : named ? `hsla(${h}, 48%, 58%, 0.30)` : 'rgba(150, 150, 150, 0.08)',
          stroke: religious
            ? 'rgba(236, 228, 210, 0.45)'
            : tint ? lighter(tint, 0.5) : named ? `hsla(${h}, 55%, 80%, 0.85)` : 'rgba(200, 200, 200, 0.25)',
        });
        if (named && s.main && realmKey(s) !== this.quietRealm) {
          const label = this.displayName(s.name);
          const text = this.lettering(`${s.id}:${label}`, s.main, label, 'realm');
          if (text) names.push({ text, style: 'realm' });
          // One watermark per realm, over its largest piece, centered behind the middle of its name.
          if (text?.glyphs.length && !marked.has(realmKey(s))) {
            marked.add(realmKey(s));
            const mid = text.glyphs[Math.floor(text.glyphs.length / 2)]!;
            anchors.push({ key: realmKey(s), qid: s.qid, lon: mid.lon, lat: mid.lat, main: bounds([s.main]), area: s });
          }
        }
      } else {
        // A vassal inside its realm: a faint line, as on a strategy map.
        drawn.push({ ...s, fill: '', stroke: tint ? withAlpha(lighter(tint, 0.7), 0.35) : `hsla(${h}, 40%, 88%, 0.35)`, inner: true });
      }
    }
    const layer = new ImageryLayer(new BordersTiles(drawn, 'normal', names) as unknown as ImageryProvider, { alpha: 0 });
    layer.show = this.visible;
    // Just above the basemap: points, regions and outlines stay on top.
    this.viewer.imageryLayers.add(layer, this.layer ? this.viewer.imageryLayers.indexOf(this.layer) + 1 : undefined);
    this.crossFade(this.layer, layer);
    this.layer = layer;
    this.anchors = anchors;
    this.showMarks();
    if (this.highlighted) this.highlight(this.highlighted);
  }

  /** French names come from the server progressively (looked up once, then cached). */
  private async loadNames(from: number, attempt = 0): Promise<void> {
    clearTimeout(this.namesTimer);
    try {
      const r = await fetch(`/api/polity/labels?year=${from}`);
      const res = (await r.json()) as PolityLabels;
      if (this.current?.from !== from) return;
      const changed = JSON.stringify(res.labels) !== JSON.stringify(this.frNames);
      this.frNames = res.labels;
      // Playing: the next period, drawn soon, takes the names along (no extra redraw).
      if (changed && this.loadingPeriod) this.namesDirty = true;
      else if (changed) {
        this.show();
        this.onPeriod(); // French names can match more armies to their country
      }
      if (res.pending > 0 && attempt < 12) {
        this.namesTimer = window.setTimeout(() => void this.loadNames(from, attempt + 1), 5_000);
      }
    } catch {
      /* English names stay */
    }
  }

  /** What colors the territories: realms, faiths, or nothing. */
  setBackdrop(b: Backdrop): void {
    if (b === this.backdrop) return;
    this.backdrop = b;
    // Asked again each time: faiths looked up since then show up.
    if (b === 'religion' && this.current) void this.loadFaiths(this.current.from);
    this.show();
  }

  /** Faiths of the realms come from the server progressively, like the names. */
  private async loadFaiths(from: number, attempt = 0): Promise<void> {
    clearTimeout(this.faithsTimer);
    try {
      const r = await fetch(`/api/polity/faiths?year=${from}`);
      const res = (await r.json()) as FaithsResponse;
      if (this.current?.from !== from || this.backdrop !== 'religion') return;
      const changed = this.faithsFrom !== from || JSON.stringify(res.faiths) !== JSON.stringify(this.faiths);
      this.faiths = res.faiths;
      this.faithsFrom = from;
      if (changed) this.show();
      // The server looks them up between other chores: keep asking, less and less often.
      if (res.pending > 0 && attempt < 40) {
        this.faithsTimer = window.setTimeout(() => void this.loadFaiths(from, attempt + 1), Math.min(20_000, 4_000 + attempt * 1_000));
      }
    } catch {
      /* realms stay grey */
    }
  }

  /** Shows or hides the coats of arms in watermark. */
  setHeraldry(on: boolean): void {
    if (on === this.heraldry) return;
    this.heraldry = on;
    this.showMarks();
  }

  /** The loaded coat of arms (else flag) of a realm's item, if any. */
  private emblemImage(qid: string | null): HTMLImageElement | null {
    const e = qid ? this.emblems[qid] : undefined;
    const file = e ? (e.coa ?? e.flag) : null;
    if (!file) return null;
    if (!this.emblemImages.has(file)) {
      this.emblemImages.set(file, null);
      void loadImage(commonsImage(file, 500)).then((img) => {
        this.emblemImages.set(file, img);
        if (img && !this.tints.has(file)) {
          this.tints.set(file, tintOf(img));
          this.saveTintsSoon();
          this.recolorSoon();
        }
        if (img && this.heraldry) this.redrawSoon();
        else window.setTimeout(() => this.emblemImages.delete(file), 60_000);
      });
    }
    return this.emblemImages.get(file) ?? null;
  }

  /**
   * Dominant color of a realm's emblem at the period shown, if known. An
   * emblem not measured yet is loaded (the map is recolored once it is).
   */
  private tintOf(qid: string | null): string | null {
    const e = qid ? this.emblems[qid] : undefined;
    const file = e ? (e.coa ?? e.flag) : null;
    if (!file) return null;
    if (this.tints.has(file)) return this.tints.get(file) ?? null;
    // Periods chaining (play): no new images now, the connections go to the borders.
    if (this.loadingPeriod) this.namesDirty = true;
    else this.emblemImage(qid);
    return null;
  }

  /** Colors arrive one emblem at a time: the map (and the armies) recolored once for a batch. */
  private recolorSoon(): void {
    clearTimeout(this.tintTimer);
    this.tintTimer = window.setTimeout(() => {
      if (this.backdrop !== 'political') return;
      this.show();
      this.onPeriod();
    }, 900);
  }

  private saveTintsSoon(): void {
    clearTimeout(this.tintsSaveTimer);
    this.tintsSaveTimer = window.setTimeout(() => saveTints(this.tints), 3_000);
  }

  /** Images arrive one by one: one redraw for a batch of them. */
  private redrawSoon(): void {
    clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => this.showMarks(), 600);
  }

  /** Redraws the watermarks alone, just under the realms. */
  private showMarks(): void {
    const marks: Mark[] = [];
    if (this.heraldry) {
      for (const a of this.anchors) {
        if (a.key === this.quietRealm) continue;
        const img = this.emblemImage(a.qid);
        if (!img) continue;
        // Large enough to cover the realm's main piece from its center, keeping its shape.
        const cos = Math.max(0.2, Math.cos((a.lat * Math.PI) / 180));
        const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
        const needH = Math.max(a.lat - a.main.south, a.main.north - a.lat);
        const needW = Math.max(a.lon - a.main.west, a.main.east - a.lon) * cos;
        const hh = Math.max(needH, needW / aspect) * 1.1;
        const rings = a.area.rings;
        marks.push({
          img: faded(img), lon: a.lon, lat: a.lat, hh, hw: hh * aspect, rings,
          west: a.area.west, south: a.area.south, east: a.area.east, north: a.area.north,
          boxes: rings.map((r) => bounds([r])),
        });
      }
    }
    const old = this.marksLayer;
    this.marksLayer = null;
    if (marks.length && this.layer) {
      const layer = new ImageryLayer(new BordersTiles([], 'normal', [], marks) as unknown as ImageryProvider);
      layer.show = this.visible;
      this.viewer.imageryLayers.add(layer, this.viewer.imageryLayers.indexOf(this.layer));
      this.marksLayer = layer;
    }
    // The old one stays a moment, while the new tiles are drawn.
    if (old) window.setTimeout(() => drop(this.viewer, old), this.marksLayer ? 900 : 0);
    this.viewer.scene.requestRender();
  }

  /** Coats of arms come from the server progressively, like the names. */
  private async loadEmblems(from: number, attempt = 0): Promise<void> {
    clearTimeout(this.emblemsTimer);
    try {
      const r = await fetch(`/api/polity/emblems?year=${from}`);
      const res = (await r.json()) as EmblemsResponse;
      if (this.current?.from !== from) return;
      const changed = JSON.stringify(res.emblems) !== JSON.stringify(this.emblems);
      this.emblems = res.emblems;
      this.emblemsFrom = from;
      if (changed) {
        this.showMarks();
        this.recolorSoon();
      }
      // Still being looked up: asked again, less and less often. Found: asked again from time to
      // time anyway, the server completes the emblems in the background.
      const wait = res.pending > 0 && attempt < 40 ? Math.min(20_000, 5_000 + attempt * 1_000) : 180_000;
      this.emblemsTimer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void this.loadEmblems(from, res.pending > 0 ? attempt + 1 : 0);
        else this.emblemsTimer = window.setTimeout(() => void this.loadEmblems(from), 180_000);
      }, wait);
    } catch {
      /* no watermarks */
    }
  }

  /**
   * The new borders appear over the last ones fully painted, which stay
   * until the new tiles are drawn: never a blank map between two periods.
   * When periods follow each other quickly (the timeline plays), the fade is
   * quicker, and a replacement not painted yet gives way to the newer one.
   */
  private crossFade(from: ImageryLayer | null, to: ImageryLayer): void {
    const token = ++this.fadeToken;
    // The painted base stays; an unfinished replacement (never fully drawn) goes.
    if (!this.base) this.base = from;
    else if (from && from !== this.base) drop(this.viewer, from);
    const base = this.base;
    const now = performance.now();
    const ms = now - this.lastFade < 1200 ? QUICK_FADE_MS : FADE_MS;
    this.lastFade = now;
    const step = () => {
      if (token !== this.fadeToken) return; // a newer fade took over
      const elapsed = performance.now() - now;
      const t = Math.min(1, elapsed / ms);
      this.fading = t < 1;
      to.alpha = this.alpha * t;
      if (base) base.alpha = this.alpha;
      this.viewer.scene.requestRender();
      // The old borders stay until the new tiles are painted (or a while has passed).
      const painted = queue.length === 0 && this.viewer.scene.globe.tilesLoaded;
      if (t < 1 || (!painted && elapsed < SETTLE_MAX_MS)) requestAnimationFrame(step);
      else {
        if (base) drop(this.viewer, base);
        this.base = to;
        for (const w of this.settleWaiters.splice(0)) w();
      }
    };
    requestAnimationFrame(step);
  }

  /** Resolves once the borders shown are painted (at most SETTLE_MAX_MS after the last were asked). */
  private settled(): Promise<void> {
    if (this.base === this.layer) return Promise.resolve();
    return new Promise((r) => this.settleWaiters.push(r));
  }

  /** Borders matter at empire scale; fade them out as the camera gets close to the ground. */
  setCameraHeight(h: number): void {
    const t = Math.min(1, Math.max(0, (Math.log10(h) - 4.7) / (6.5 - 4.7))); // 50 km .. 3000 km
    this.alpha = 0.12 + t * (0.85 - 0.12);
    if (this.layer && !this.fading) this.layer.alpha = this.alpha;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (this.layer) this.layer.show = v;
    if (this.highlightLayer) this.highlightLayer.show = v;
    if (this.regionsLayer) this.regionsLayer.show = v;
    if (this.marksLayer) this.marksLayer.show = v;
    this.viewer.scene.requestRender();
  }
}
