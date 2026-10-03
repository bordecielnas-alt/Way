import {
  BillboardCollection, Cartesian2, Cartesian3, Color, HorizontalOrigin, LabelCollection, LabelStyle, NearFarScalar, VerticalOrigin,
  type Viewer,
} from 'cesium';
import { figureId, PALETTE, personFigure } from './figures.ts';
import { loadImage, viaServer } from './media.ts';

// The key people of a scenario step, as a row of medallions at the place
// where it happens, the protagonist in the middle ("Vous" when invented).
// Cleared when the scenario ends or is cancelled.

export interface CastMember {
  name: string;
  role: string;
  image: string | null;
  /** The visitor's own character: gold, in the middle. */
  you?: boolean;
}

/** Pixels between two medallions of the row (room for their names). */
const SPACING = 110;

export class CastLayer {
  private billboards: BillboardCollection;
  private labels: LabelCollection;
  private token = 0;

  constructor(private viewer: Viewer) {
    this.billboards = viewer.scene.primitives.add(new BillboardCollection({ scene: viewer.scene }));
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
  }

  show(at: { lat: number; lon: number }, members: CastMember[]): void {
    const token = ++this.token;
    this.clearPrimitives();
    const position = Cartesian3.fromDegrees(at.lon, at.lat, 2000);
    const others = members.filter((m) => !m.you);
    const centered = members.some((m) => m.you);
    members.forEach((m, i) => {
      // In a row, names below: the protagonist on the spot, the others to its left and right in turn.
      const k = others.indexOf(m);
      const slot = m.you ? 0 : centered ? Math.ceil((k + 1) / 2) * (k % 2 ? -1 : 1) : (k - (others.length - 1) / 2);
      const offset = new Cartesian2(slot * SPACING, 0);
      const color = m.you ? PALETTE[0]! : PALETTE[(i % (PALETTE.length - 1)) + 1]!;
      const draw = (portrait: HTMLImageElement | null) => personFigure('medallion', color, 'event', m.name, portrait);
      const first = draw(null);
      const bb = this.billboards.add({
        position, pixelOffset: offset, verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(3e5, 1.1, 2e7, 0.6),
      });
      bb.setImage(figureId(first), first);
      this.labels.add({
        position, text: `${m.name}\n${m.role}`, font: '600 12px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.fromCssColorString(m.you ? '#f2c66d' : '#f4ead6'), outlineColor: Color.fromCssColorString('#07090d').withAlpha(0.9),
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.TOP, horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(offset.x, offset.y + 4), disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      if (m.image) {
        void loadImage(viaServer(m.image)).then((img) => {
          if (!img || token !== this.token) return;
          const c = draw(img);
          bb.setImage(figureId(c), c);
          this.viewer.scene.requestRender();
        });
      }
    });
    this.viewer.scene.requestRender();
  }

  clear(): void {
    this.token++;
    this.clearPrimitives();
    this.viewer.scene.requestRender();
  }

  private clearPrimitives(): void {
    this.billboards.removeAll();
    this.labels.removeAll();
  }
}
