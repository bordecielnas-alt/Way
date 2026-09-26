import {
  Cartesian3, Color, Credit, ImageryLayer, Ion, Math as CesiumMath, Rectangle, UrlTemplateImageryProvider, Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Rect } from '@way/shared';

export type Basemap = 'natural-earth' | 'satellite';

// No Cesium ion: every asset is local or from a free, configurable tile source.
Ion.defaultAccessToken = '';

const SATELLITE_URL =
  import.meta.env.VITE_SATELLITE_URL ||
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_CREDIT = import.meta.env.VITE_SATELLITE_CREDIT || 'Imagerie © Esri, Maxar, Earthstar Geographics';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

function esri(service: string, maximumLevel: number, credit: string): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({
    url: `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`,
    maximumLevel,
    credit: new Credit(credit),
  });
}

function basemapLayers(name: Basemap): ImageryLayer[] {
  if (name === 'satellite') {
    return [
      new ImageryLayer(
        new UrlTemplateImageryProvider({ url: SATELLITE_URL, maximumLevel: 18, credit: new Credit(SATELLITE_CREDIT) }),
      ),
    ];
  }
  // Relief: a physical map without modern borders, roads or labels (to level 8, ~600 m/px),
  // with a finer hillshade (to level 13) blended in when zooming close.
  return [
    new ImageryLayer(esri('World_Physical_Map', 8, 'Relief © Esri, US National Park Service'), {
      brightness: 0.82,
    }),
    new ImageryLayer(esri('World_Shaded_Relief', 13, 'Ombrage © Esri'), {
      minimumTerrainLevel: 7,
      alpha: 0.35,
    }),
  ];
}

const basemap = new Set<ImageryLayer>();

export function createGlobe(container: HTMLElement, name: Basemap): Viewer {
  const viewer = new Viewer(container, {
    baseLayer: false,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // Performance: no MSAA (costly on integrated GPUs), and frames are only
    // rendered when something changes instead of 60 times per second.
    msaaSamples: 1,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });
  const scene = viewer.scene;
  scene.globe.baseColor = Color.fromCssColorString('#0b1624');
  scene.backgroundColor = Color.fromCssColorString('#05070b');
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  scene.globe.tileCacheSize = 400; // keep tiles of recently visited places while strolling
  scene.screenSpaceCameraController.minimumZoomDistance = 400;
  scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;
  scene.renderError.addEventListener((_s, e) => console.error('[render]', e, (e as Error)?.stack));
  setBasemap(viewer, name);
  return viewer;
}

export function setBasemap(viewer: Viewer, name: Basemap): void {
  const layers = viewer.imageryLayers;
  const old = [...basemap];
  basemap.clear();
  // New layers go at the bottom, under the borders; the old ones are then dropped.
  basemapLayers(name).forEach((l, i) => {
    layers.add(l, i);
    basemap.add(l);
  });
  for (const l of old) layers.remove(l, true);
  viewer.scene.requestRender();
}

/** Visible lon/lat rectangle in degrees, with a fallback for sky-facing views. */
export function viewRect(viewer: Viewer): Rect {
  const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (r) {
    return {
      west: CesiumMath.toDegrees(r.west),
      south: CesiumMath.toDegrees(r.south),
      east: CesiumMath.toDegrees(r.east),
      north: CesiumMath.toDegrees(r.north),
    };
  }
  const c = viewer.camera.positionCartographic;
  const lon = CesiumMath.toDegrees(c.longitude);
  const lat = CesiumMath.toDegrees(c.latitude);
  return { west: lon - 60, south: Math.max(-89, lat - 45), east: lon + 60, north: Math.min(89, lat + 45) };
}

export interface CameraState { lon: number; lat: number; height: number; heading: number; pitch: number }

export function cameraState(viewer: Viewer): CameraState {
  const c = viewer.camera.positionCartographic;
  return {
    lon: CesiumMath.toDegrees(c.longitude),
    lat: CesiumMath.toDegrees(c.latitude),
    height: c.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
  };
}

export function restoreCamera(viewer: Viewer, s: CameraState): void {
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(s.lon, s.lat, s.height),
    orientation: { heading: s.heading, pitch: s.pitch, roll: 0 },
  });
}

export { Rectangle };
