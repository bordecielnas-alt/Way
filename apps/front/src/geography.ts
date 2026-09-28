import {
  Credit, Event as CesiumEvent, GeographicTilingScheme, ImageryLayer, Math as CesiumMath,
  UrlTemplateImageryProvider, WebMercatorTilingScheme, type ImageryProvider, type Viewer,
} from 'cesium';
import { basemapCount } from './globe.ts';

// Géographie: the land itself under the borders: relief, forests, steppes,
// deserts, marshes, ice, rivers and lakes. Today's land (NASA MODIS land
// cover of 2001, Esri hillshade, Natural Earth rivers): close to the past
// for mountains and rivers, less so for forests.

export interface Geography {
  relief: boolean;
  forests: boolean;
  shrubs: boolean;
  grass: boolean;
  deserts: boolean;
  wetlands: boolean;
  ice: boolean;
  rivers: boolean;
}
export const NO_GEOGRAPHY: Geography = {
  relief: false, forests: false, shrubs: false, grass: false, deserts: false, wetlands: false, ice: false, rivers: false,
};

type Cover = 'forests' | 'shrubs' | 'grass' | 'deserts' | 'wetlands' | 'ice';

/** Toggles of the Géographie section, with their color on the map (the legend). */
export const GEOGRAPHY: { key: keyof Geography; label: string; title: string; color: string }[] = [
  { key: 'relief', label: 'Relief', title: 'Ombrage des montagnes et des vallées', color: '#b9b2a4' },
  { key: 'rivers', label: 'Fleuves et lacs', title: 'Grands fleuves, rivières et lacs', color: '#6fa9dc' },
  { key: 'forests', label: 'Forêts', title: 'Forêts (couvert actuel, avant les défrichements récents autant que possible)', color: '#2f7a45' },
  { key: 'shrubs', label: 'Savanes et maquis', title: 'Savanes, broussailles et maquis', color: '#9a9448' },
  { key: 'grass', label: 'Prairies et steppes', title: 'Prairies et steppes', color: '#c2bf62' },
  { key: 'deserts', label: 'Déserts', title: 'Déserts de sable et de roche', color: '#e0c285' },
  { key: 'wetlands', label: 'Marais', title: 'Marais et zones humides', color: '#3f93a3' },
  { key: 'ice', label: 'Glaces', title: 'Glaciers et neiges éternelles', color: '#eef5fb' },
];

/** MODIS land cover colors (IGBP classes, NASA GIBS color map) -> our kinds of land. */
const IGBP: [number, number, number, Cover][] = [
  [33, 138, 33, 'forests'], [49, 204, 49, 'forests'], [152, 204, 49, 'forests'], [150, 250, 150, 'forests'], [141, 186, 141, 'forests'],
  [186, 141, 141, 'shrubs'], [245, 222, 179, 'shrubs'], [218, 235, 157, 'shrubs'], [255, 213, 0, 'shrubs'],
  [240, 185, 103, 'grass'],
  [71, 131, 181, 'wetlands'],
  [255, 255, 255, 'ice'],
  [191, 191, 189, 'deserts'],
];
/** Painted colors (with their strength over the basemap). */
const PAINT: Record<Cover, [number, number, number, number]> = {
  forests: [38, 110, 58, 150],
  shrubs: [150, 144, 72, 105],
  grass: [196, 192, 98, 100],
  deserts: [228, 196, 132, 120],
  wetlands: [52, 140, 158, 150],
  ice: [240, 247, 252, 170],
};
const COVER_BY_RGB = new Map(IGBP.map(([r, g, b, c]) => [(r << 16) | (g << 8) | b, c]));

function loadTile(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

/** Land cover tiles (through the server, which keeps them), repainted with only the kinds chosen. */
class CoverTiles {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  readonly maximumLevel = 8;
  readonly minimumLevel = 0;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new CesiumEvent();
  readonly credit = new Credit('Occupation du sol : NASA MODIS (GIBS), 2001');
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;

  constructor(private kinds: Set<Cover>) {}

  getTileCredits(): undefined {
    return undefined;
  }

  pickFeatures(): undefined {
    return undefined;
  }

  async requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    const img = await loadTile(`/api/geo/landcover/${level}/${x}/${y}.png`);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, 256, 256);
    const data = g.getImageData(0, 0, 256, 256);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const cover = COVER_BY_RGB.get((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
      const paint = cover && this.kinds.has(cover) ? PAINT[cover] : null;
      if (!paint) {
        d[i + 3] = 0;
        continue;
      }
      d[i] = paint[0];
      d[i + 1] = paint[1];
      d[i + 2] = paint[2];
      d[i + 3] = paint[3];
    }
    g.putImageData(data, 0, 0);
    return c;
  }
}

interface Water { rank: number; pts: number[][]; west: number; south: number; east: number; north: number }

/** Rivers and lakes drawn tile by tile, thicker for the great rivers and as the camera comes close. */
class WaterTiles {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  readonly maximumLevel = 12;
  readonly minimumLevel = 0;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new CesiumEvent();
  readonly credit = new Credit('Fleuves et lacs : Natural Earth');
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;

  constructor(private rivers: Water[], private lakes: Water[]) {}

  getTileCredits(): undefined {
    return undefined;
  }

  pickFeatures(): undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    return Promise.resolve(this.draw(x, y, level));
  }

  private draw(x: number, y: number, level: number): HTMLCanvasElement {
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const west = CesiumMath.toDegrees(r.west);
    const east = CesiumMath.toDegrees(r.east);
    const south = CesiumMath.toDegrees(r.south);
    const north = CesiumMath.toDegrees(r.north);
    const sx = 256 / (east - west);
    const sy = 256 / (north - south);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const pad = 2 / sx;
    const path = (w: Water) => {
      g.beginPath();
      for (const [i, [lon, lat]] of w.pts.entries()) {
        const px = (lon! - west) * sx;
        const py = (north - lat!) * sy;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
    };
    g.fillStyle = 'rgba(88, 150, 206, 0.7)';
    g.strokeStyle = 'rgba(150, 200, 238, 0.8)';
    g.lineWidth = 0.8;
    for (const l of this.lakes) {
      if (l.east < west - pad || l.west > east + pad || l.north < south - pad || l.south > north + pad) continue;
      path(l);
      g.closePath();
      g.fill();
      g.stroke();
    }
    // The great rivers show from afar; the small ones as the camera comes down.
    const zoom = Math.min(1.6, 0.45 + level * 0.18);
    g.strokeStyle = 'rgba(110, 172, 226, 0.9)';
    for (const w of this.rivers) {
      if (w.rank > 3 + level) continue;
      if (w.east < west - pad || w.west > east + pad || w.north < south - pad || w.south > north + pad) continue;
      g.lineWidth = Math.max(0.6, (3.2 - w.rank * 0.35) * zoom);
      path(w);
      g.stroke();
    }
    return c;
  }
}

function unpack(q: number, packed: number[]): Water {
  const pts: number[][] = [];
  let x = 0, y = 0;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (let i = 0; i + 1 < packed.length; i += 2) {
    x += packed[i]!;
    y += packed[i + 1]!;
    const lon = x * q;
    const lat = y * q;
    pts.push([lon, lat]);
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return { rank: 0, pts, west, south, east, north };
}

/** The Géographie layers, just above the basemap and under the borders. */
export class GeographyLayer {
  private cover: ImageryLayer | null = null;
  private relief: ImageryLayer | null = null;
  private water: ImageryLayer | null = null;
  private waterData: Promise<WaterTiles | null> | null = null;
  private state: Geography = { ...NO_GEOGRAPHY };

  constructor(private viewer: Viewer) {}

  set(next: Geography): void {
    const prev = this.state;
    this.state = { ...next };
    const layers = this.viewer.imageryLayers;
    const kinds = new Set((['forests', 'shrubs', 'grass', 'deserts', 'wetlands', 'ice'] as Cover[]).filter((k) => next[k]));
    const coverChanged = [...kinds].sort().join() !== (['forests', 'shrubs', 'grass', 'deserts', 'wetlands', 'ice'] as Cover[]).filter((k) => prev[k]).sort().join();
    if (coverChanged || (kinds.size && !this.cover)) {
      const old = this.cover;
      this.cover = null;
      if (kinds.size) {
        this.cover = new ImageryLayer(new CoverTiles(kinds) as unknown as ImageryProvider);
        layers.add(this.cover, basemapCount());
      }
      // The old one stays a moment, while the new tiles come.
      if (old) window.setTimeout(() => layers.remove(old, true), this.cover ? 1200 : 0);
    }
    if (next.relief !== !!this.relief) {
      if (next.relief) {
        this.relief = new ImageryLayer(
          new UrlTemplateImageryProvider({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 13,
            credit: new Credit('Ombrage © Esri'),
          }),
          { alpha: 0.42 },
        );
        layers.add(this.relief, basemapCount() + (this.cover ? 1 : 0));
      } else if (this.relief) {
        layers.remove(this.relief, true);
        this.relief = null;
      }
    }
    if (next.rivers !== !!this.water) {
      if (next.rivers) void this.showWater();
      else if (this.water) {
        layers.remove(this.water, true);
        this.water = null;
      }
    }
    this.viewer.scene.requestRender();
  }

  private async showWater(): Promise<void> {
    this.waterData ??= fetch('/geo/rivers.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { q: number; rivers: number[][]; lakes: number[][] }) => {
        const rivers = d.rivers.map(([rank, ...packed]) => ({ ...unpack(d.q, packed), rank: rank! })).sort((a, b) => b.rank - a.rank);
        return new WaterTiles(rivers, d.lakes.map((p) => unpack(d.q, p)));
      })
      .catch(() => {
        this.waterData = null;
        return null;
      });
    const tiles = await this.waterData;
    if (!tiles || !this.state.rivers || this.water) return;
    this.water = new ImageryLayer(tiles as unknown as ImageryProvider);
    this.viewer.imageryLayers.add(this.water, basemapCount() + (this.cover ? 1 : 0) + (this.relief ? 1 : 0));
    this.viewer.scene.requestRender();
  }
}
