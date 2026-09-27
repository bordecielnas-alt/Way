import {
  Cartesian3, Color, DistanceDisplayCondition, Event as CesiumEvent, GeographicTilingScheme, HorizontalOrigin,
  ImageryLayer, LabelCollection, LabelStyle, Math as CesiumMath, NearFarScalar, Rectangle, VerticalOrigin,
  type ImageryProvider, type Viewer,
} from 'cesium';
import { formatYear, type PolityLabels } from '@way/shared';

type Ring = [number, number][];
interface Feature {
  properties: { NAME?: string | null; SUBJECTO?: string | null; PARTOF?: string | null };
  geometry: { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] } | null;
}

/** One territory, ready to draw: its rings, bounding box (degrees) and colors. */
interface Shape {
  name: string | null;
  /** Overlord (SUBJECTO / PARTOF): an empire is outlined with its vassals. */
  owner: string | null;
  rings: Ring[];
  west: number; south: number; east: number; north: number;
  fill: string;
  stroke: string;
}

const TILE = 256;
const HAIR_SPACE = String.fromCharCode(0x200a);
type Style = 'normal' | 'highlight';
const FADE_MS = 700;
/** Main-thread time spent drawing border tiles per frame, so panning stays smooth. */
const FRAME_BUDGET_MS = 6;

function hue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

function polygons(f: Feature): Ring[][] {
  if (!f.geometry) return [];
  return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
}

function ringBoxArea(ring: Ring): number {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return (e - w) * (n - s);
}

function toShape(f: Feature): Shape | null {
  const rings = polygons(f).flat();
  if (rings.length === 0) return null;
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  const owner = (f.properties.SUBJECTO || f.properties.PARTOF)?.trim() || null;
  const name = f.properties.NAME?.trim() || null;
  const h = hue(owner || name || '?');
  // The dataset leaves some land unnamed: neutral, so it is not mistaken for a realm.
  const named = !!(name || owner);
  return {
    name, owner,
    rings, west, south, east, north,
    fill: named ? `hsla(${h}, 48%, 58%, 0.30)` : 'rgba(150, 150, 150, 0.08)',
    stroke: named ? `hsla(${h}, 55%, 78%, 0.8)` : 'rgba(200, 200, 200, 0.25)',
  };
}

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

/**
 * Imagery provider that rasterizes the border polygons tile by tile, at the
 * tile's own resolution: lines stay one pixel wide and sharp at every zoom.
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

  constructor(private shapes: Shape[], private style: Style = 'normal') {
    // The highlight only covers its territory: Cesium then requests no other tile.
    const s = shapes[0];
    this.rectangle = style === 'highlight' && s
      ? Rectangle.fromDegrees(Math.max(-180, s.west - 1), Math.max(-90, s.south - 1), Math.min(180, s.east + 1), Math.min(90, s.north + 1))
      : this.tilingScheme.rectangle;
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
    g.lineWidth = 1.2;
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
      g.fillStyle = s.fill;
      g.fill('evenodd');
      g.strokeStyle = s.stroke;
      g.stroke();
    }
    return canvas;
  }
}

/**
 * Historical borders draped on the globe as an imagery layer: tiles are drawn
 * on demand, and snapshots cross-fade when the timeline moves.
 */
export class BordersLayer {
  private years: number[] = [];
  private current: number | null = null;
  private layer: ImageryLayer | null = null;
  private labels: LabelCollection;
  private cache = new Map<number, Feature[]>();
  private loading: number | null = null;
  private alpha = 0.85;
  private fading = false;
  private wanted: number | null = null;
  private visible = true;
  private shapes: Shape[] = [];
  private features: Feature[] = [];
  private highlightLayer: ImageryLayer | null = null;
  private highlighted: string | null = null;
  private frNames: Record<string, string> = {};
  private namesTimer: number | undefined;

  constructor(private viewer: Viewer, private onNote: (text: string) => void) {
    this.labels = viewer.scene.primitives.add(new LabelCollection());
    onDrained = () => viewer.scene.requestRender();
  }

  async init(): Promise<void> {
    try {
      const r = await fetch('/api/borders');
      this.years = ((await r.json()) as { years: number[] }).years;
    } catch {
      this.years = [];
    }
    if (this.years.length === 0) {
      // First start of the server: snapshots are still downloading. Retry.
      this.onNote('Frontières historiques en cours de téléchargement…');
      setTimeout(async () => {
        await this.init();
        if (this.wanted != null) await this.setYear(this.wanted);
      }, 20_000);
    }
  }

  snapshotFor(year: number): number | null {
    let pick: number | null = this.years[0] ?? null;
    for (const y of this.years) if (y <= year) pick = y;
    return pick;
  }

  async setYear(year: number): Promise<void> {
    this.wanted = year;
    const snap = this.snapshotFor(year);
    if (snap === null || snap === this.current || snap === this.loading) return;
    this.loading = snap;
    try {
      let features = this.cache.get(snap);
      if (!features) {
        const r = await fetch(`/api/borders?year=${snap}`);
        features = ((await r.json()) as { features: Feature[] }).features;
        this.cache.set(snap, features);
      }
      if (this.loading !== snap) return; // superseded
      this.current = snap;
      this.frNames = {};
      this.show(features);
      void this.loadNames(snap);
      this.onNote(`Frontières approximatives · état de ${formatYear(snap)}`);
    } catch (e) {
      console.warn('borders failed', e);
    } finally {
      if (this.loading === snap) this.loading = null;
    }
  }

  /**
   * Territory under a point (the innermost one when territories nest),
   * or null over the sea and unclaimed land.
   */
  territoryAt(lon: number, lat: number): string | null {
    let best: Shape | null = null;
    let bestArea = Infinity;
    for (const s of this.shapes) {
      if (!(s.name ?? s.owner) || lon < s.west || lon > s.east || lat < s.south || lat > s.north) continue;
      let inside = false;
      for (const ring of s.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]!;
          const [xj, yj] = ring[j]!;
          if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      const area = (s.east - s.west) * (s.north - s.south);
      if (inside && area < bestArea) {
        best = s;
        bestArea = area;
      }
    }
    return best ? (best.name ?? best.owner) : null;
  }

  /** French name shown on the map for a snapshot name, when known. */
  displayName(name: string): string {
    return this.frNames[name] ?? name;
  }

  /** Outlines a territory by name (null clears). Kept across snapshots while the name exists. */
  highlight(name: string | null): void {
    this.highlighted = name;
    if (this.highlightLayer) {
      this.viewer.imageryLayers.remove(this.highlightLayer, true);
      this.highlightLayer = null;
    }
    const parts = name ? this.shapes.filter((s) => s.name === name || s.owner === name) : [];
    if (parts.length) {
      const merged: Shape = {
        ...parts[0]!,
        rings: parts.flatMap((p) => p.rings),
        west: Math.min(...parts.map((p) => p.west)),
        south: Math.min(...parts.map((p) => p.south)),
        east: Math.max(...parts.map((p) => p.east)),
        north: Math.max(...parts.map((p) => p.north)),
      };
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

  private show(features: Feature[]): void {
    const shapes = features.map(toShape).filter((s): s is Shape => s !== null);
    this.shapes = shapes;
    const layer = new ImageryLayer(new BordersTiles(shapes) as unknown as ImageryProvider, { alpha: 0 });
    layer.show = this.visible;
    this.viewer.imageryLayers.add(layer); // above the basemap
    this.crossFade(this.layer, layer);
    this.layer = layer;
    this.features = features;
    this.setLabels();
    if (this.highlighted) this.highlight(this.highlighted);
  }

  /** French names come from the server progressively (looked up once, then cached). */
  private async loadNames(snap: number, attempt = 0): Promise<void> {
    clearTimeout(this.namesTimer);
    try {
      const r = await fetch(`/api/polity/labels?year=${snap}`);
      const res = (await r.json()) as PolityLabels;
      if (this.current !== snap) return;
      const changed = Object.keys(res.labels).length !== Object.keys(this.frNames).length;
      this.frNames = res.labels;
      if (changed) this.setLabels();
      if (res.pending > 0 && attempt < 12) {
        this.namesTimer = window.setTimeout(() => void this.loadNames(snap, attempt + 1), 10_000);
      }
    } catch {
      /* English names stay */
    }
  }

  private setLabels(): void {
    const features = this.features;
    this.labels.removeAll();
    for (const f of features) {
      const name = f.properties.NAME;
      if (!name) continue;
      // Label at the center of the largest outer ring's bounding box.
      let best: Ring | null = null;
      let bestArea = 0;
      for (const poly of polygons(f)) {
        const a = poly[0] ? ringBoxArea(poly[0]) : 0;
        if (a > bestArea) { bestArea = a; best = poly[0]!; }
      }
      if (!best || bestArea < 0.5) continue;
      let sx = 0, sy = 0;
      for (const [x, y] of best) { sx += x; sy += y; }
      const h = hue(f.properties.SUBJECTO || f.properties.PARTOF || name);
      // Map lettering: size grows with the territory, big realms get spaced capitals.
      const size = Math.round(Math.min(22, Math.max(11, 9 + Math.sqrt(bestArea) * 0.5)));
      const text = this.displayName(name.trim()).toUpperCase();
      this.labels.add({
        position: Cartesian3.fromDegrees(sx / best.length, sy / best.length, 2000),
        text: size >= 16 ? [...text].join(HAIR_SPACE) : text,
        font: `600 ${size}px "EB Garamond", Georgia, serif`,
        fillColor: Color.fromCssColorString(`hsl(${h}, 40%, 92%)`).withAlpha(0.6),
        outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.45),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        // A watermark: fainter up close, so it never hides the points.
        translucencyByDistance: new NearFarScalar(5e5, 0.45, 4e6, 1),
        // Large territories are labeled from far away, small ones only up close.
        distanceDisplayCondition: new DistanceDisplayCondition(1.5e5, Math.min(2.5e7, Math.sqrt(bestArea) * 9e5)),
      });
    }
    this.cullLabels();
    this.viewer.scene.requestRender();
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
  /**
   * Labels are drawn a little above the ground, so near the horizon their text
   * spills into space: hide those on the far side of the globe.
   */
  cullLabels(): void {
    const cam = this.viewer.camera.positionWC;
    const n = new Cartesian3();
    const d = new Cartesian3();
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels.get(i);
      Cartesian3.normalize(l.position, n);
      Cartesian3.normalize(Cartesian3.subtract(cam, l.position, d), d);
      l.show = Cartesian3.dot(n, d) > 0.2;
    }
  }

  setCameraHeight(h: number): void {
    const t = Math.min(1, Math.max(0, (Math.log10(h) - 4.7) / (6.5 - 4.7))); // 50 km .. 3000 km
    this.alpha = 0.12 + t * (0.85 - 0.12);
    if (this.layer && !this.fading) this.layer.alpha = this.alpha;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (this.layer) this.layer.show = v;
    if (this.highlightLayer) this.highlightLayer.show = v;
    this.labels.show = v;
    this.viewer.scene.requestRender();
  }
}
