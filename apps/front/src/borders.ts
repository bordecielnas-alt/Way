import {
  Cartesian3, Color, DistanceDisplayCondition, Event as CesiumEvent, GeographicTilingScheme, HorizontalOrigin,
  ImageryLayer, LabelCollection, LabelStyle, Math as CesiumMath, NearFarScalar, VerticalOrigin,
  type ImageryProvider, type Viewer,
} from 'cesium';
import { formatYear } from '@way/shared';

type Ring = [number, number][];
interface Feature {
  properties: { NAME?: string | null; SUBJECTO?: string | null; PARTOF?: string | null };
  geometry: { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] } | null;
}

/** One territory, ready to draw: its rings, bounding box (degrees) and colors. */
interface Shape {
  rings: Ring[];
  west: number; south: number; east: number; north: number;
  fill: string;
  stroke: string;
}

const TILE = 256;
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
  const h = hue(f.properties.SUBJECTO || f.properties.PARTOF || f.properties.NAME || '?');
  return {
    rings, west, south, east, north,
    fill: `hsla(${h}, 48%, 58%, 0.30)`,
    stroke: `hsla(${h}, 55%, 78%, 0.8)`,
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
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = TILE;
  readonly tileHeight = TILE;
  readonly maximumLevel = 14;
  readonly minimumLevel = 0;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new CesiumEvent();
  readonly credit = undefined;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;

  constructor(private shapes: Shape[]) {}

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
    const pad = 2 / sx; // strokes straddle the tile edge

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
      this.show(features);
      this.current = snap;
      this.onNote(`Frontières approximatives · état de ${formatYear(snap)}`);
    } catch (e) {
      console.warn('borders failed', e);
    } finally {
      if (this.loading === snap) this.loading = null;
    }
  }

  private show(features: Feature[]): void {
    const shapes = features.map(toShape).filter((s): s is Shape => s !== null);
    const layer = new ImageryLayer(new BordersTiles(shapes) as unknown as ImageryProvider, { alpha: 0 });
    layer.show = this.visible;
    this.viewer.imageryLayers.add(layer); // above the basemap
    this.crossFade(this.layer, layer);
    this.layer = layer;
    this.setLabels(features);
  }

  private setLabels(features: Feature[]): void {
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
      this.labels.add({
        position: Cartesian3.fromDegrees(sx / best.length, sy / best.length, 2000),
        text: name.toUpperCase(),
        font: 'italic 500 13px "EB Garamond", Georgia, serif',
        fillColor: Color.fromCssColorString(`hsl(${h}, 45%, 86%)`).withAlpha(0.9),
        outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.8),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(1e6, 1.1, 1.5e7, 0.7),
        // Large territories are labeled from far away, small ones only up close.
        distanceDisplayCondition: new DistanceDisplayCondition(3e5, Math.min(2.5e7, Math.sqrt(bestArea) * 9e5)),
      });
    }
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
  setCameraHeight(h: number): void {
    const t = Math.min(1, Math.max(0, (Math.log10(h) - 4.7) / (6.5 - 4.7))); // 50 km .. 3000 km
    this.alpha = 0.12 + t * (0.85 - 0.12);
    if (this.layer && !this.fading) this.layer.alpha = this.alpha;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (this.layer) this.layer.show = v;
    this.labels.show = v;
    this.viewer.scene.requestRender();
  }
}
