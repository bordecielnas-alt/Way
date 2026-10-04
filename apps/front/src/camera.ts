import {
  BoundingSphere, Cartesian3, EasingFunction, HeadingPitchRange, Math as CesiumMath, SceneTransforms, type Viewer,
} from 'cesium';

// One way to move the camera for every place the app takes the visitor to:
// it does not move when the place already shows in the part of the map the
// panels leave visible; otherwise it glides there keeping its height (within
// what the place calls for) and its tilt, the place at the middle of that
// part. No hop up and down on the way. A height the visitor chose by hand
// holds until a new path starts.

/** The part of the map left visible by the panels, in canvas pixels. */
export interface Zone { left: number; top: number; right: number; bottom: number }

export interface CameraAim {
  /** Heights (m) the place calls for: the camera keeps its own within them. */
  min?: number;
  max?: number;
  /** This height exactly. */
  height?: number;
  /** Moves even when the place shows already. */
  force?: boolean;
}

type LatLon = { lat: number; lon: number };

/** Margin (px) a place keeps from the edges of the visible part to count as shown. */
const EDGE = 36;
/** Steepest and flattest tilts the camera keeps (radians below the horizon). */
const FLAT = CesiumMath.toRadians(-40);
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class CameraGuide {
  /** A flight of ours is under way: the camera's moves are not the visitor's. */
  private ours = 0;
  private startHeight = 0;
  /** The visitor zoomed by hand: their height holds. */
  private manual = false;

  constructor(private viewer: Viewer, private zone: () => Zone) {
    const camera = viewer.camera;
    camera.moveStart.addEventListener(() => {
      this.startHeight = camera.positionCartographic.height;
    });
    camera.moveEnd.addEventListener(() => {
      if (this.ours) return;
      const h = camera.positionCartographic.height;
      if (this.startHeight && Math.abs(h - this.startHeight) / this.startHeight > 0.2) this.manual = true;
    });
  }

  /** A new path: the camera may choose heights again. */
  resetHeight(): void {
    this.manual = false;
  }

  /** Does the place show in the visible part of the map (and on this side of the globe)? */
  shows(p: LatLon): boolean {
    const scene = this.viewer.scene;
    const world = Cartesian3.fromDegrees(p.lon, p.lat);
    // On the far side of the globe: the camera is behind the ground there.
    const toCamera = Cartesian3.subtract(this.viewer.camera.positionWC, world, new Cartesian3());
    if (Cartesian3.dot(toCamera, world) <= 0) return false;
    const at = SceneTransforms.worldToWindowCoordinates(scene, world);
    if (!at) return false;
    const z = this.zone();
    // Hard against an edge is not shown: a tenth of the visible part at least.
    const m = Math.max(EDGE, 0.1 * Math.min(z.right - z.left, z.bottom - z.top));
    return at.x >= z.left + m && at.x <= z.right - m && at.y >= z.top + m && at.y <= z.bottom - m;
  }

  /** To a place, as little as needed. */
  to(p: LatLon, aim: CameraAim = {}): void {
    const camera = this.viewer.camera;
    const h = camera.positionCartographic.height;
    const want = aim.height ?? (this.manual ? h : clamp(h, aim.min ?? 0, aim.max ?? Infinity));
    if (!aim.force && Math.abs(want - h) / h < 0.15 && this.shows(p)) return;
    this.fly(p, want);
  }

  /**
   * Several places at once (a path's steps), framed in the visible part;
   * too far apart for the highest height allowed, only `focus` is gone to.
   */
  frame(points: LatLon[], aim: CameraAim = {}, focus?: LatLon): void {
    if (!points.length) return;
    const lats = points.map((p) => p.lat);
    // Longitudes around the first one, so a path across the antimeridian stays whole.
    const ref = points[0]!.lon;
    const lons = points.map((p) => ref + ((((p.lon - ref) % 360) + 540) % 360) - 180);
    const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    const center = { lat: (s + n) / 2, lon: ((((w + e) / 2) + 540) % 360) - 180 };
    const z = this.zone();
    const canvas = this.viewer.scene.canvas;
    const zw = Math.max(120, z.right - z.left - 2 * EDGE);
    const zh = Math.max(120, z.bottom - z.top - 2 * EDGE);
    const widthM = (e - w) * 111_320 * Math.cos(CesiumMath.toRadians(center.lat));
    const heightM = (n - s) * 111_320;
    const mpp = Math.max(widthM / zw, heightM / zh);
    const needed = (mpp * canvas.clientWidth) / (2 * Math.tan(this.fovX() / 2));
    if (focus && needed > (aim.max ?? Infinity)) return this.to(focus, aim);
    const height = clamp(needed, aim.min ?? 0, aim.max ?? Infinity);
    if (points.every((p) => this.shows(p)) && !aim.force) {
      const h = this.viewer.camera.positionCartographic.height;
      if (h >= (aim.min ?? 0) && h <= (aim.max ?? Infinity)) return;
    }
    this.fly(center, this.manual ? this.viewer.camera.positionCartographic.height : height);
  }

  private fovX(): number {
    const canvas = this.viewer.scene.canvas;
    const f = this.viewer.camera.frustum as { fov?: number; aspectRatio?: number };
    const aspect = f.aspectRatio ?? canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const fov = f.fov ?? Math.PI / 3;
    return aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) * aspect);
  }

  /** Glides so the place shows at the middle of the visible part, from `height`, keeping heading and tilt. */
  private fly(p: LatLon, height: number): void {
    const camera = this.viewer.camera;
    const canvas = this.viewer.scene.canvas;
    const heading = camera.heading;
    const pitch = clamp(camera.pitch, -CesiumMath.PI_OVER_TWO, FLAT);
    const sinP = Math.sin(-pitch);
    const range = height / Math.max(0.2, sinP);
    // Where the middle of the visible part is, from the middle of the canvas.
    const z = this.zone();
    const dx = (z.left + z.right) / 2 - canvas.clientWidth / 2;
    const dy = (z.top + z.bottom) / 2 - canvas.clientHeight / 2;
    const mpp = (2 * range * Math.tan(this.fovX() / 2)) / Math.max(1, canvas.clientWidth);
    // The camera aims beside the place: to its west when it should show right of the middle, north when below.
    const right = -dx * mpp;
    const forward = (dy * mpp) / Math.max(0.35, sinP);
    const east = right * Math.cos(heading) + forward * Math.sin(heading);
    const north = -right * Math.sin(heading) + forward * Math.cos(heading);
    const lat = clamp(p.lat + north / 111_320, -89, 89);
    const lon = p.lon + east / (111_320 * Math.max(0.1, Math.cos(CesiumMath.toRadians(p.lat))));
    const target = Cartesian3.fromDegrees(lon, lat);
    const from = camera.positionCartographic;
    const km = Cartesian3.distance(Cartesian3.fromRadians(from.longitude, from.latitude), target) / 1000;
    const duration = reduced() ? 0 : clamp(0.6 + km / 2500, 0.7, 2);
    this.ours++;
    const done = () => {
      this.ours = Math.max(0, this.ours - 1);
    };
    camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
      offset: new HeadingPitchRange(heading, pitch, range),
      duration,
      // Never higher than the higher end: no climb and dive between two places.
      maximumHeight: Math.max(from.height, height) * 1.1,
      easingFunction: EasingFunction.QUADRATIC_IN_OUT,
      complete: done,
      cancel: done,
    });
  }
}
