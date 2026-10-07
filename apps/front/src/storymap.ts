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
// While the file plays, only the steps beside the one now: the next one
// joined by a plain arrow, the one before by dashes, nothing more (the
// routes the step may take are offered by the scenario's card, not drawn).
// The step now is a pin of its own, kept on the map when the visitor goes
// elsewhere: a click on it brings the scenario back.

const PHASE_COLORS: Record<StoryPhase, string> = { before: '#5b8fd1', during: '#d9a441', after: '#d673b1' };
/** Names of the main places show from this far (meters), the dots from farther. */
const LABEL_FAR = 9_000_000;
const GOLD = '#f2c66d';
const IVORY = '#f4ead6';
const NIGHT = '#07090d';

/** A step beside the one now, as drawn: before it or after it. */
export interface StepAround {
  step: WalkStep;
  label: string;
}

export class StoryLayer {
  private points: PointPrimitiveCollection;
  private labels: LabelCollection;
  private lines: PolylineCollection;
  /** The step now: on its own, not cleared with the rest. */
  private pinPoints: PointPrimitiveCollection;
  private pinLabels: LabelCollection;
  private pin: WalkStep | null = null;
  private stops: StoryStop[] = [];
  /** The steps drawn beside the one now: -1 before it, 1 after it. */
  private around = new Map<number, WalkStep>();

  constructor(private viewer: Viewer) {
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
    this.lines = viewer.scene.primitives.add(new PolylineCollection());
    this.pinPoints = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.pinLabels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
  }

  private line(a: { lat: number; lon: number }, b: { lat: number; lon: number }, material: Material, width: number): void {
    const pts = greatCircle([a.lat, a.lon], [b.lat, b.lon], 32);
    if (pts.length < 2) return;
    this.lines.add({ positions: pts.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, 600)), width, material });
  }

  /** The steps beside the one now: the next joined by a plain arrow, the one before by dashes. */
  showWalk(now: WalkStep, prev: StepAround | null, next: StepAround | null): void {
    this.clear();
    const same = (a: WalkStep, b: WalkStep) => a.lat === b.lat && a.lon === b.lon;
    if (prev && !same(prev.step, now)) {
      this.line(prev.step, now, Material.fromType('PolylineDash', { color: Color.fromCssColorString(IVORY).withAlpha(0.6), dashLength: 12 }), 2);
    }
    if (next && !same(next.step, now)) {
      this.line(now, next.step, Material.fromType('PolylineArrow', { color: Color.fromCssColorString(GOLD).withAlpha(0.95) }), 9);
    }
    for (const [side, a] of [[-1, prev], [1, next]] as const) {
      if (!a || same(a.step, now)) continue;
      this.around.set(side, a.step);
      const position = Cartesian3.fromDegrees(a.step.lon, a.step.lat, 1500);
      this.points.add({
        position, id: { step: side }, pixelSize: 9,
        color: Color.fromCssColorString(side < 0 ? '#d9a441' : IVORY).withAlpha(0.8),
        outlineColor: Color.fromCssColorString(NIGHT).withAlpha(0.85), outlineWidth: 2,
        scaleByDistance: new NearFarScalar(3e5, 1.3, 2e7, 0.7), disableDepthTestDistance: 5e6,
      });
      this.labels.add({
        position, id: { step: side }, text: `${a.label}. ${a.step.place}`,
        font: '600 12px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.fromCssColorString(IVORY).withAlpha(side < 0 ? 0.75 : 1), outlineColor: Color.fromCssColorString(NIGHT).withAlpha(0.9),
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -10),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2e7), disableDepthTestDistance: 5e6,
      });
    }
    this.viewer.scene.requestRender();
  }

  /**
   * The scenario's pin: the step now, a little larger than the others, its
   * number and place written; it stays while the visitor looks elsewhere
   * (`paused`: drawn a touch quieter). Null takes it away.
   */
  setPin(step: WalkStep | null, label = '', paused = false): void {
    this.pinPoints.removeAll();
    this.pinLabels.removeAll();
    this.pin = step;
    if (step) {
      const position = Cartesian3.fromDegrees(step.lon, step.lat, 1800);
      this.pinPoints.add({
        position, id: { pin: true }, pixelSize: 18,
        color: Color.fromCssColorString(GOLD).withAlpha(paused ? 0.85 : 1),
        outlineColor: Color.fromCssColorString(paused ? IVORY : NIGHT).withAlpha(0.9), outlineWidth: paused ? 2.5 : 3,
        scaleByDistance: new NearFarScalar(3e5, 1.35, 2e7, 0.8), disableDepthTestDistance: 5e6,
      });
      this.pinLabels.add({
        position, id: { pin: true }, text: paused ? `◎ ${label}. ${step.place}` : `${label}. ${step.place}`,
        font: '700 13px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.fromCssColorString(GOLD), outlineColor: Color.fromCssColorString(NIGHT).withAlpha(0.9),
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -13),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2.5e7), disableDepthTestDistance: 5e6,
      });
    }
    this.viewer.scene.requestRender();
  }

  /** The scenario's pin's step, if the pin is under the cursor. */
  pickPin(at: Cartesian2): WalkStep | null {
    if (!this.pin) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { pin?: boolean } } | undefined;
    return hit?.id?.pin ? this.pin : null;
  }

  /** The step drawn before (-1) or after (1) the one now. */
  besideStep(side: -1 | 1): WalkStep | null {
    return this.around.get(side) ?? null;
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
    this.around.clear();
    this.points.removeAll();
    this.labels.removeAll();
    this.lines.removeAll();
    this.viewer.scene.requestRender();
  }

  /** The step beside the one now under the cursor, if any: -1 the one before, 1 the next. */
  pickStep(at: Cartesian2): -1 | 1 | null {
    if (!this.around.size) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { step?: number } } | undefined;
    const side = hit?.id?.step;
    return side === -1 || side === 1 ? side : null;
  }

  /** The story's place under the cursor, if any. */
  pick(at: Cartesian2): StoryStop | null {
    if (!this.stops.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { story?: number } } | undefined;
    const i = hit?.id?.story;
    return typeof i === 'number' ? this.stops[i] ?? null : null;
  }
}
