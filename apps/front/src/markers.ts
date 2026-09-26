import {
  BoundingSphere, CallbackProperty, Cartesian2, Cartesian3, Color, ConstantProperty, CustomDataSource,
  DistanceDisplayCondition, Entity, HeadingPitchRange, HorizontalOrigin, LabelStyle, Math as CesiumMath,
  NearFarScalar, VerticalOrigin, type Viewer,
} from 'cesium';
import { poiInWindow, type Category, type PoiLite } from '@way/shared';
import { clusterIcon, markerIcon, sizeFor } from './icons.ts';

const POP_MS = 650;

/**
 * POI markers on the globe: clustering, time filtering, "light up" animation.
 * Only POIs of the current window and filters get an entity: Cesium updates
 * every entity each frame, so hidden ones would still cost time.
 */
export class PoiLayer {
  readonly source = new CustomDataSource('pois');
  private pois = new Map<string, PoiLite>();
  private window = { tStart: -500, tEnd: -300 };
  private hidden = new Set<Category>();
  private selected: string | null = null;
  private syncQueued = false;
  private animateUntil = 0;
  private animating = false;

  constructor(private viewer: Viewer) {
    const c = this.source.clustering;
    c.enabled = true;
    c.pixelRange = 26;
    c.minimumClusterSize = 3;
    c.clusterEvent.addEventListener((entities, cluster) => {
      cluster.label.show = false;
      cluster.billboard.show = true;
      // Billboard.image accepts canvases at runtime; the typings only say string.
      cluster.billboard.image = clusterIcon(entities.length) as unknown as string;
      cluster.billboard.verticalOrigin = VerticalOrigin.CENTER;
      cluster.billboard.id = cluster.label.id; // lets picks return the cluster entities
    });
    viewer.dataSources.add(this.source);
  }

  get(id: string): PoiLite | undefined {
    return this.pois.get(id);
  }

  /** Counts per category among POIs of the current window (for the filter panel). */
  countsInWindow(): Map<Category, number> {
    const m = new Map<Category, number>();
    for (const p of this.pois.values()) {
      if (poiInWindow(p, this.window.tStart, this.window.tEnd)) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    }
    return m;
  }

  upsert(pois: PoiLite[]): void {
    const ents = this.source.entities;
    ents.suspendEvents();
    let popped = false;
    for (const p of pois) {
      if (this.pois.has(p.id)) continue;
      this.pois.set(p.id, p);
      if (this.isVisible(p)) {
        this.addEntity(p, true);
        popped = true;
      }
    }
    ents.resumeEvents();
    if (popped) this.animate(POP_MS + 100);
    this.viewer.scene.requestRender();
  }

  setWindow(tStart: number, tEnd: number): void {
    this.window = { tStart, tEnd };
    this.queueSync();
  }

  setHidden(hidden: Set<Category>): void {
    this.hidden = hidden;
    this.queueSync();
  }

  select(id: string | null): void {
    const prev = this.selected ? this.source.entities.getById(this.selected) : undefined;
    if (prev?.billboard) prev.billboard.color = new ConstantProperty(Color.WHITE);
    this.selected = id;
    const cur = id ? this.source.entities.getById(id) : undefined;
    if (cur) this.pulse(cur);
    this.animate(0);
  }

  /** Fly the camera to a POI with a slight tilt. */
  flyTo(p: PoiLite): void {
    const h = this.viewer.camera.positionCartographic.height;
    const range = Math.min(1.8e6, Math.max(2.5e4, h * 0.45));
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(p.lon, p.lat), 0), {
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-55), range),
      duration: 2.2,
    });
  }

  /** Returns a POI id or the entities of a cluster under the cursor. */
  pick(position: Cartesian2): { poi?: PoiLite; cluster?: Entity[] } {
    const picked = this.viewer.scene.pick(position);
    const id = picked?.id;
    if (Array.isArray(id)) return { cluster: id as Entity[] };
    if (id instanceof Entity) {
      const p = this.pois.get(id.id);
      if (p) return { poi: p };
    }
    return {};
  }

  private isVisible(p: PoiLite): boolean {
    return !this.hidden.has(p.category) && poiInWindow(p, this.window.tStart, this.window.tEnd);
  }

  /** Timeline drags fire many times per frame: reconcile entities at most once per frame. */
  private queueSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    requestAnimationFrame(() => {
      this.syncQueued = false;
      this.sync();
    });
  }

  private sync(): void {
    const ents = this.source.entities;
    ents.suspendEvents();
    for (const p of this.pois.values()) {
      const e = ents.getById(p.id);
      const vis = this.isVisible(p);
      if (vis && !e) this.addEntity(p, false);
      else if (!vis && e) ents.remove(e);
    }
    ents.resumeEvents();
    this.viewer.scene.requestRender();
  }

  private addEntity(p: PoiLite, pop: boolean): void {
    const size = sizeFor(p.importance);
    const box = size + 12;
    const born = performance.now();
    const e = this.source.entities.add({
      id: p.id,
      position: Cartesian3.fromDegrees(p.lon, p.lat),
      billboard: {
        image: markerIcon(p.category, size),
        width: box,
        height: box,
        scale: pop
          ? new CallbackProperty(() => {
              const t = Math.min(1, (performance.now() - born) / POP_MS);
              // Ease-out-back: grows past full size, then settles.
              return Math.max(0, 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2);
            }, false)
          : 1,
        verticalOrigin: VerticalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(2e5, 1.15, 2e7, 0.75),
        disableDepthTestDistance: 5e4,
      },
      label: {
        text: p.title,
        font: `500 ${p.importance > 0.7 ? 15 : 13}px "EB Garamond", Georgia, serif`,
        fillColor: Color.fromCssColorString('#ece4d2'),
        outlineColor: Color.fromCssColorString('#07090d'),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.CENTER,
        pixelOffset: new Cartesian2(size / 2 + 6, 0),
        // Important places are labeled from farther away.
        distanceDisplayCondition: new DistanceDisplayCondition(0, 1.5e5 + p.importance ** 2.5 * 1.3e7),
        disableDepthTestDistance: 5e4,
      },
    });
    if (pop) {
      setTimeout(() => {
        if (e.billboard) e.billboard.scale = new ConstantProperty(1);
      }, POP_MS + 50);
    }
    if (p.id === this.selected) this.pulse(e);
  }

  private pulse(e: Entity): void {
    if (!e.billboard) return;
    e.billboard.color = new CallbackProperty(
      () => Color.WHITE.withAlpha(0.65 + 0.35 * Math.sin(performance.now() / 260) ** 2),
      false,
    );
  }

  /**
   * The scene only renders on demand: keep requesting frames while an
   * animation runs (marker pop for `ms`, selection pulse while selected).
   */
  private animate(ms: number): void {
    this.animateUntil = Math.max(this.animateUntil, performance.now() + ms);
    if (this.animating) return;
    this.animating = true;
    const tick = () => {
      this.viewer.scene.requestRender();
      if (performance.now() < this.animateUntil || this.selected) requestAnimationFrame(tick);
      else this.animating = false;
    };
    requestAnimationFrame(tick);
  }
}
