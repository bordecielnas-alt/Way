import {
  Cartesian2, Cartesian3, Color, DistanceDisplayCondition, HorizontalOrigin, LabelCollection, LabelStyle, NearFarScalar,
  PointPrimitiveCollection, VerticalOrigin, type Viewer,
} from 'cesium';
import type { Story, StoryPhase, StoryStop } from '@way/shared';

// The places of the open card's story on the globe: its own places as
// named points (gold where it happened, blue its origins, rose what it led
// to), the places its article only cites as small dots. A place with its
// own card is ringed: a door into its own story. Cleared with the card.

const PHASE_COLORS: Record<StoryPhase, string> = { before: '#5b8fd1', during: '#d9a441', after: '#d673b1' };
/** Names of the main places show from this far (meters), the dots from farther. */
const LABEL_FAR = 9_000_000;

export class StoryLayer {
  private points: PointPrimitiveCollection;
  private labels: LabelCollection;
  private stops: StoryStop[] = [];

  constructor(private viewer: Viewer) {
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
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
    this.points.removeAll();
    this.labels.removeAll();
    this.viewer.scene.requestRender();
  }

  /** The story's place under the cursor, if any. */
  pick(at: Cartesian2): StoryStop | null {
    if (!this.stops.length) return null;
    const hit = this.viewer.scene.pick(at) as { id?: { story?: number } } | undefined;
    const i = hit?.id?.story;
    return typeof i === 'number' ? this.stops[i] ?? null : null;
  }
}
