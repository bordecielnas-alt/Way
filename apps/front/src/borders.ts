import {
  Cartesian3, Color, DistanceDisplayCondition, HorizontalOrigin, ImageryLayer, LabelCollection, LabelStyle,
  NearFarScalar, Rectangle, SingleTileImageryProvider, VerticalOrigin, type Viewer,
} from 'cesium';
import { formatYear } from '@way/shared';

type Ring = [number, number][];
interface Feature {
  properties: { NAME?: string | null; SUBJECTO?: string | null; PARTOF?: string | null };
  geometry: { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] } | null;
}

const W = 4096;
const H = 2048;
const FADE_MS = 700;

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

/**
 * Historical borders rendered to an equirectangular canvas and draped on
 * the globe as a single imagery layer: cheap to draw and easy to cross-fade.
 */
export class BordersLayer {
  private years: number[] = [];
  private current: number | null = null;
  private layer: ImageryLayer | null = null;
  private labels: LabelCollection;
  private cache = new Map<number, Feature[]>();
  private loading: number | null = null;
  private urls = new Map<ImageryLayer, string>();
  private alpha = 0.85;
  private fading = false;
  private wanted: number | null = null;

  constructor(private viewer: Viewer, private onNote: (text: string) => void) {
    this.labels = viewer.scene.primitives.add(new LabelCollection());
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
      await this.show(features);
      this.current = snap;
      this.onNote(`Frontières approximatives · état de ${formatYear(snap)}`);
    } catch (e) {
      console.warn('borders failed', e);
    } finally {
      if (this.loading === snap) this.loading = null;
    }
  }

  private async show(features: Feature[]): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d')!;
    g.lineJoin = 'round';
    const px = (lon: number) => ((lon + 180) / 360) * W;
    const py = (lat: number) => ((90 - lat) / 180) * H;

    this.labels.removeAll();
    for (const f of features) {
      const polys = polygons(f);
      if (polys.length === 0) continue;
      const owner = f.properties.SUBJECTO || f.properties.PARTOF || f.properties.NAME || '?';
      const h = hue(owner);
      g.beginPath();
      for (const poly of polys) {
        for (const ring of poly) {
          ring.forEach(([lon, lat], i) => (i === 0 ? g.moveTo(px(lon), py(lat)) : g.lineTo(px(lon), py(lat))));
          g.closePath();
        }
      }
      g.fillStyle = `hsla(${h}, 48%, 58%, 0.30)`;
      g.fill('evenodd');
      g.strokeStyle = `hsla(${h}, 55%, 78%, 0.75)`;
      g.lineWidth = 1.4;
      g.stroke();

      const name = f.properties.NAME;
      if (!name) continue;
      // Label at the center of the largest outer ring's bounding box.
      let best: Ring | null = null;
      let bestArea = 0;
      for (const poly of polys) {
        const a = poly[0] ? ringBoxArea(poly[0]) : 0;
        if (a > bestArea) { bestArea = a; best = poly[0]!; }
      }
      if (!best || bestArea < 0.5) continue;
      let sx = 0, sy = 0;
      for (const [x, y] of best) { sx += x; sy += y; }
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

    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    const url = URL.createObjectURL(blob);
    const provider = await SingleTileImageryProvider.fromUrl(url, { rectangle: Rectangle.MAX_VALUE });
    const layer = new ImageryLayer(provider, { alpha: 0 });
    this.urls.set(layer, url);
    this.viewer.imageryLayers.add(layer); // above the basemap
    this.crossFade(this.layer, layer);
    this.layer = layer;
  }

  private crossFade(from: ImageryLayer | null, to: ImageryLayer): void {
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / FADE_MS);
      this.fading = t < 1;
      to.alpha = this.alpha * t;
      if (from) from.alpha = this.alpha * (1 - t);
      if (t < 1) requestAnimationFrame(step);
      else if (from) {
        this.viewer.imageryLayers.remove(from, true);
        const old = this.urls.get(from);
        if (old) URL.revokeObjectURL(old);
        this.urls.delete(from);
      }
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
    if (this.layer) this.layer.show = v;
    this.labels.show = v;
  }
}
