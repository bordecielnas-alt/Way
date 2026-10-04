import {
  Cartesian2, Cartesian3, Color, DistanceDisplayCondition, HorizontalOrigin, LabelCollection, LabelStyle, NearFarScalar,
  PointPrimitiveCollection, VerticalOrigin, type Viewer,
} from 'cesium';
import type { Story, StoryPhase, StoryStop, WalkStep } from '@way/shared';

// The places of the open card's story on the globe: its own places as
// named points (gold where it happened, blue its origins, rose what it led
// to), the places its article only cites as small dots. A place with its
// own card is ringed: a door into its own story. Cleared with the card.
// While a path plays, its steps instead, numbered, the one played in gold.

const PHASE_COLORS: Record<StoryPhase, string> = { before: '#5b8fd1', during: '#d9a441', after: '#d673b1' };
/** Names of the main places show from this far (meters), the dots from farther. */
const LABEL_FAR = 9_000_000;

export class StoryLayer {
  private points: PointPrimitiveCollection;
  private labels: LabelCollection;
  private stops: StoryStop[] = [];
  private steps: WalkStep[] = [];

  constructor(private viewer: Viewer) {
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
  }

  /** The steps of the path played, numbered; `at`: the one played. */
  showWalk(steps: WalkStep[], at: number): void {
    this.clear();
    this.steps = steps;
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
    this.points.removeAll();
    this.labels.removeAll();
    this.viewer.scene.requestRender();
  }

  /** The path's step under the cursor, if any. */
  pickStep(at: Cartesian2): { j: number; step: WalkStep } | null {
    if (!this.steps.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { step?: number } } | undefined;
    const j = hit?.id?.step;
    return typeof j === 'number' && this.steps[j] ? { j, step: this.steps[j]! } : null;
  }

  /** The story's place under the cursor, if any. */
  pick(at: Cartesian2): StoryStop | null {
    if (!this.stops.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { story?: number } } | undefined;
    const i = hit?.id?.story;
    return typeof i === 'number' ? this.stops[i] ?? null : null;
  }
}
