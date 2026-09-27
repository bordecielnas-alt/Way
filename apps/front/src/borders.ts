import {
  Event as CesiumEvent, GeographicTilingScheme, ImageryLayer, Math as CesiumMath, Rectangle,
  type ImageryProvider, type Viewer,
} from 'cesium';
import { formatYear, type BordersIndex, type BordersPeriod, type PolityLabels } from '@way/shared';
import { bounds, type Area, type Region, type Ring } from './divisions.ts';
import { letter, shortName, type Lettering } from './lettering.ts';

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

const TILE = 256;
type Style = 'normal' | 'highlight' | 'regions';
const FADE_MS = 700;
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

  constructor(private shapes: Drawn[], private style: Style = 'normal', private names: Named[] = []) {
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
    this.drawNames(g, west, south, east, north, sx, sy);
    return canvas;
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
  private wanted: number | null = null;
  private visible = true;
  private highlightLayer: ImageryLayer | null = null;
  private highlighted: string | null = null;
  private frNames: Record<string, string> = {};
  private regionsLayer: ImageryLayer | null = null;
  /** Realm split into regions: its own name gives way to theirs. */
  private quietRealm: string | null = null;
  private namesTimer: number | undefined;
  private letterings = new Map<string, Lettering | null>();

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

  async setYear(year: number): Promise<void> {
    this.wanted = year;
    const from = this.periodStart(year);
    if (from === null || from === this.current?.from) return;
    try {
      const period = await this.load(from);
      if (this.periodStart(this.wanted) !== from) return; // superseded
      this.current = period;
      this.show();
      void this.loadNames(from);
      this.onNote(`Frontières de ${formatYear(period.from)}${period.to > period.from ? ` à ${formatYear(period.to)}` : ''}`);
      // Playing forward: the next period is fetched ahead.
      const next = this.index!.events.find((y) => y > period.to);
      if (next !== undefined) void this.load(next).catch(() => undefined);
    } catch (e) {
      console.warn('borders failed', e);
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
      this.viewer.imageryLayers.remove(this.highlightLayer, true);
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
      this.viewer.imageryLayers.remove(this.regionsLayer, true);
      this.regionsLayer = null;
    }
    const was = this.quietRealm;
    this.quietRealm = regions?.length ? realm : null;
    if (regions?.length) {
      const drawn: Drawn[] = regions.map((r) => ({
        ...r,
        fill: `hsla(${hue(r.qid)}, 45%, 60%, 0.24)`,
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
    const drawn: Drawn[] = [];
    const names: Named[] = [];
    // Big realms first: small ones inside or across them stay visible.
    const byId = new Map(period.shapes.map((s) => [s.id, s]));
    const ordered = [...period.shapes].sort((a, b) => (a.parent === null ? 0 : 1) - (b.parent === null ? 0 : 1) || b.km2 - a.km2);
    for (const s of ordered) {
      const root = byId.get(s.root) ?? s;
      const h = hue(realmKey(root));
      const named = !!s.name;
      if (s.parent === null) {
        drawn.push({
          ...s,
          fill: named ? `hsla(${h}, 48%, 58%, 0.30)` : 'rgba(150, 150, 150, 0.08)',
          stroke: named ? `hsla(${h}, 55%, 80%, 0.85)` : 'rgba(200, 200, 200, 0.25)',
        });
        if (named && s.main && realmKey(s) !== this.quietRealm) {
          const label = this.displayName(s.name);
          const text = this.lettering(`${s.id}:${label}`, s.main, label, 'realm');
          if (text) names.push({ text, style: 'realm' });
        }
      } else {
        // A vassal inside its realm: a faint line, as on a strategy map.
        drawn.push({ ...s, fill: '', stroke: `hsla(${h}, 40%, 88%, 0.35)`, inner: true });
      }
    }
    const layer = new ImageryLayer(new BordersTiles(drawn, 'normal', names) as unknown as ImageryProvider, { alpha: 0 });
    layer.show = this.visible;
    // Just above the basemap: points, regions and outlines stay on top.
    this.viewer.imageryLayers.add(layer, this.layer ? this.viewer.imageryLayers.indexOf(this.layer) + 1 : undefined);
    this.crossFade(this.layer, layer);
    this.layer = layer;
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
      if (changed) this.show();
      if (res.pending > 0 && attempt < 12) {
        this.namesTimer = window.setTimeout(() => void this.loadNames(from, attempt + 1), 5_000);
      }
    } catch {
      /* English names stay */
    }
  }

  private crossFade(from: ImageryLayer | null, to: ImageryLayer): void {
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / FADE_MS);
      this.fading = t < 1;
      to.alpha = this.alpha * t;
      if (from) from.alpha = this.alpha * (1 - t);
      this.viewer.scene.requestRender();
      if (t < 1) requestAnimationFrame(step);
      else if (from) this.viewer.imageryLayers.remove(from, true);
    };
    requestAnimationFrame(step);
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
    this.viewer.scene.requestRender();
  }
}
