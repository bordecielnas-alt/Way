import {
  Cartesian2, Cartesian3, Color, DistanceDisplayCondition, HorizontalOrigin, LabelCollection, LabelStyle, Material, NearFarScalar,
  PointPrimitiveCollection, PolylineCollection, VerticalOrigin, type Viewer,
} from 'cesium';
import type { Story, StoryPhase, StoryStop, WalkStep } from '@way/shared';
import { greatCircle } from './living.ts';

// The places of the open card's story on the globe: its own places as
// named points (gold where it happened, blue its origins, rose what it led
// to), the places its article only cites as small dots. A place with its
// own card is ringed: a door into its own story. Cleared with the card.
// While a path plays, its steps instead, numbered, the one played in gold,
// the route lived drawn plain, the route ahead dashed; from the step played,
// where it may go: the way on (an arrow), its turning points (blue dashes)
// and the places of its detours, each clickable.

/** Where a path may go from the step played. */
export interface RouteOption {
  key: string;
  kind: 'next' | 'fork' | 'detour';
  label: string;
  lat: number;
  lon: number;
}

const OPTION_COLORS: Record<RouteOption['kind'], string> = { next: '#f2c66d', fork: '#7fb3e0', detour: '#f4ead6' };

const PHASE_COLORS: Record<StoryPhase, string> = { before: '#5b8fd1', during: '#d9a441', after: '#d673b1' };
/** Names of the main places show from this far (meters), the dots from farther. */
const LABEL_FAR = 9_000_000;

export class StoryLayer {
  private points: PointPrimitiveCollection;
  private labels: LabelCollection;
  private lines: PolylineCollection;
  private options: RouteOption[] = [];
  private stops: StoryStop[] = [];
  private steps: WalkStep[] = [];

  constructor(private viewer: Viewer) {
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
    this.lines = viewer.scene.primitives.add(new PolylineCollection());
  }

  private line(a: { lat: number; lon: number }, b: { lat: number; lon: number }, material: Material, width: number): void {
    const pts = greatCircle([a.lat, a.lon], [b.lat, b.lon], 32);
    if (pts.length < 2) return;
    this.lines.add({ positions: pts.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, 600)), width, material });
  }

  /** The steps of the path played, numbered; `at`: the one played; `options`: where it may go from there. */
  showWalk(steps: WalkStep[], at: number, options: RouteOption[] = []): void {
    this.clear();
    this.steps = steps;
    this.options = options;
    const gold = Color.fromCssColorString('#d9a441');
    const ivory = Color.fromCssColorString('#f4ead6');
    steps.forEach((s, j) => {
      const b = steps[j + 1];
      if (!b || (b.lat === s.lat && b.lon === s.lon)) return;
      const lived = j < at;
      this.line(s, b, lived ? Material.fromType('Color', { color: gold.withAlpha(0.7) }) : Material.fromType('PolylineDash', { color: ivory.withAlpha(0.35), dashLength: 12 }), lived ? 2.5 : 1.5);
    });
    const here = steps[at];
    if (here) {
      options.forEach((o, k) => {
        const color = Color.fromCssColorString(OPTION_COLORS[o.kind]);
        const far = o.lat !== here.lat || o.lon !== here.lon;
        if (far) {
          this.line(here, o, o.kind === 'next' ? Material.fromType('PolylineArrow', { color: color.withAlpha(0.95) })
            : Material.fromType('PolylineDash', { color: color.withAlpha(o.kind === 'fork' ? 0.9 : 0.6), dashLength: o.kind === 'fork' ? 14 : 6 }), o.kind === 'next' ? 9 : o.kind === 'fork' ? 3 : 2);
        }
        if (o.kind === 'next' || !far) return;
        const position = Cartesian3.fromDegrees(o.lon, o.lat, 1500);
        this.points.add({
          position, id: { option: k }, pixelSize: o.kind === 'fork' ? 11 : 8, color: color.withAlpha(0.95),
          outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.85), outlineWidth: 2,
          scaleByDistance: new NearFarScalar(3e5, 1.3, 2e7, 0.7), disableDepthTestDistance: 5e6,
        });
        this.labels.add({
          position, id: { option: k }, text: `${o.kind === 'fork' ? '⑂ ' : '↪ '}${o.label}`,
          font: '600 12px "Inter Variable", system-ui, sans-serif',
          fillColor: color, outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.9), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -10),
          distanceDisplayCondition: new DistanceDisplayCondition(0, 2e7), disableDepthTestDistance: 5e6,
        });
      });
    }
    steps.forEach((s, j) => {
      const position = Cartesian3.fromDegrees(s.lon, s.lat, 1500);
      const on = j === at;
      this.points.add({
        position, id: { step: j },
        pixelSize: on ? 14 : 9,
        color: Color.fromCssColorString(on ? '#f2c66d' : j < at ? '#d9a441' : '#f4ead6').withAlpha(on ? 1 : 0.75),
        outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.85), outlineWidth: 2,
        scaleByDistance: new NearFarScalar(3e5, 1.3, 2e7, 0.7),
        disableDepthTestDistance: 5e6,
      });
      this.labels.add({
        position, id: { step: j },
        text: on ? `${j + 1}. ${s.place}` : String(j + 1),
        font: `${on ? 700 : 600} 12px "Inter Variable", system-ui, sans-serif`,
        fillColor: Color.fromCssColorString(on ? '#f2c66d' : '#f4ead6'), outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.9),
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -10),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2e7),
        disableDepthTestDistance: 5e6,
      });
    });
    this.viewer.scene.requestRender();
  }

  show(story: Story): void {
    this.clear();
    this.stops = story.stops;
    story.stops.forEach((s, i) => {
      const main = s.main !== false;
      const position = Cartesian3.fromDegrees(s.lon, s.lat, 1500);
      const color = Color.fromCssColorString(PHASE_COLORS[s.phase]);
      this.points.add({
        position, id: { story: i },
        pixelSize: main ? 11 : 6,
        color: color.withAlpha(main ? 0.95 : 0.6),
        // A door into its own story: a light ring.
        outlineColor: s.poi ? Color.fromCssColorString('#f4ead6').withAlpha(main ? 0.95 : 0.7) : Color.fromCssColorString('#07090d').withAlpha(0.8),
        outlineWidth: s.poi ? 2.5 : 1.5,
        scaleByDistance: new NearFarScalar(3e5, 1.3, 2e7, 0.7),
        disableDepthTestDistance: 5e6,
      });
      if (!main) return;
      this.labels.add({
        position, id: { story: i },
        text: s.poi?.title ?? s.name,
        font: '600 12px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.fromCssColorString('#f4ead6'), outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.9),
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -9),
        distanceDisplayCondition: new DistanceDisplayCondition(0, LABEL_FAR),
        scaleByDistance: new NearFarScalar(3e5, 1, 9e6, 0.75),
        disableDepthTestDistance: 5e6,
      });
    });
    this.viewer.scene.requestRender();
  }

  clear(): void {
    this.stops = [];
    this.steps = [];
    this.options = [];
    this.points.removeAll();
    this.labels.removeAll();
    this.lines.removeAll();
    this.viewer.scene.requestRender();
  }

  /** The path's step under the cursor, if any. */
  pickStep(at: Cartesian2): { j: number; step: WalkStep } | null {
    if (!this.steps.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { step?: number } } | undefined;
    const j = hit?.id?.step;
    return typeof j === 'number' && this.steps[j] ? { j, step: this.steps[j]! } : null;
  }

  /** Where the path may go, under the cursor (a turning point, a detour's place), if any. */
  pickOption(at: Cartesian2): RouteOption | null {
    if (!this.options.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { option?: number } } | undefined;
    const k = hit?.id?.option;
    return typeof k === 'number' ? this.options[k] ?? null : null;
  }

  /** The story's place under the cursor, if any. */
  pick(at: Cartesian2): StoryStop | null {
    if (!this.stops.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { story?: number } } | undefined;
    const i = hit?.id?.story;
    return typeof i === 'number' ? this.stops[i] ?? null : null;
  }
}
