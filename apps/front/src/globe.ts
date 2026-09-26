import {
  buildModuleUrl, Cartesian3, Color, Credit, ImageryLayer, Ion, Math as CesiumMath, Rectangle,
  TileMapServiceImageryProvider, UrlTemplateImageryProvider, Viewer,
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

function basemapLayer(name: Basemap): ImageryLayer {
  if (name === 'satellite') {
    return new ImageryLayer(
      new UrlTemplateImageryProvider({ url: SATELLITE_URL, maximumLevel: 18, credit: new Credit(SATELLITE_CREDIT) }),
    );
  }
  // Natural Earth II ships with Cesium: a relief map without modern borders or roads.
  return ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
  );
}

export function createGlobe(container: HTMLElement, basemap: Basemap): Viewer {
  const viewer = new Viewer(container, {
    baseLayer: basemapLayer(basemap),
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
    msaaSamples: 4,
  });
  const scene = viewer.scene;
  scene.globe.baseColor = Color.fromCssColorString('#0b1624');
  scene.backgroundColor = Color.fromCssColorString('#05070b');
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  scene.screenSpaceCameraController.minimumZoomDistance = 400;
  scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;
  scene.renderError.addEventListener((_s, e) => console.error('[render]', e, (e as Error)?.stack));
  return viewer;
}

export function setBasemap(viewer: Viewer, name: Basemap): void {
  const layers = viewer.imageryLayers;
  const old = layers.get(0);
  layers.add(basemapLayer(name), 0);
  if (old) layers.remove(old, true);
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
