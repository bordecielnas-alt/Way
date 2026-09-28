import type { Category, Theme } from '@way/shared';

/** One hue per theme: its categories are shades of it, so the map reads by family. */
export const THEME_COLORS: Record<Theme, string> = {
  geography: '#63b86c',
  settlement: '#e8c468',
  state: '#b18be0',
  war: '#e0594a',
  religion: '#7fb3e0',
  culture: '#dd7fd4',
  knowledge: '#6fa0ff',
  trade: '#5cc8b8',
  exploration: '#c3d96b',
  disaster: '#ff8a3d',
  society: '#eeeae0',
};

/** People cross themes: their own color. */
export const PEOPLE_COLOR = '#e07fb0';

export const CATEGORY_COLORS: Record<Category, string> = {
  battle: THEME_COLORS.war,
  fortification: '#b9695c',
  city: THEME_COLORS.settlement,
  place: '#a9a39a',
  polity: THEME_COLORS.state,
  monument: '#e8a6dc',
  religion: THEME_COLORS.religion,
  person: PEOPLE_COLOR,
  event: THEME_COLORS.society,
  discovery: '#9dbbff',
  science: THEME_COLORS.knowledge,
  disaster: THEME_COLORS.disaster,
  trade: THEME_COLORS.trade,
  exploration: THEME_COLORS.exploration,
  art: THEME_COLORS.culture,
  nature: THEME_COLORS.geography,
};

/** Canvases are drawn at the screen's pixel density so markers stay crisp. */
const DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
const cache = new Map<string, HTMLCanvasElement>();

type Shape = 'shield' | 'hex' | 'diamond' | 'circle';
const SHAPES: Partial<Record<Category, Shape>> = {
  battle: 'shield', fortification: 'shield', disaster: 'diamond', city: 'hex', polity: 'hex', monument: 'hex', trade: 'hex',
};

// ---------- color helpers ----------

function mix(hex: string, to: number, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - t) + to * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
const light = (hex: string, t: number) => mix(hex, 255, t);
const dark = (hex: string, t: number) => mix(hex, 0, t);

/** Rim metal by importance: gold for major points, silver, then bronze. */
function metal(importance: number): [string, string, string] {
  if (importance >= 0.7) return ['#fff1c2', '#e0b24f', '#7a5317'];
  if (importance >= 0.4) return ['#ffffff', '#c3c7cf', '#5d626c'];
  return ['#f6d2ac', '#b8784a', '#5a3417'];
}

// ---------- token outline ----------

function shapePath(g: CanvasRenderingContext2D, shape: Shape, cx: number, cy: number, r: number): void {
  g.beginPath();
  switch (shape) {
    case 'circle':
      g.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case 'hex':
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        g.lineTo(cx + Math.cos(a) * r * 1.06, cy + Math.sin(a) * r * 1.06);
      }
      g.closePath();
      break;
    case 'diamond':
      g.moveTo(cx, cy - r * 1.18);
      g.lineTo(cx + r * 1.05, cy);
      g.lineTo(cx, cy + r * 1.18);
      g.lineTo(cx - r * 1.05, cy);
      g.closePath();
      break;
    case 'shield':
      g.moveTo(cx - r * 0.95, cy - r * 0.9);
      g.quadraticCurveTo(cx, cy - r * 1.15, cx + r * 0.95, cy - r * 0.9);
      g.lineTo(cx + r * 0.95, cy - r * 0.1);
      g.quadraticCurveTo(cx + r * 0.9, cy + r * 0.75, cx, cy + r * 1.15);
      g.quadraticCurveTo(cx - r * 0.9, cy + r * 0.75, cx - r * 0.95, cy - r * 0.1);
      g.closePath();
      break;
  }
}

// ---------- pictograms, drawn in a [-1, 1] box ----------

type Draw = (g: CanvasRenderingContext2D) => void;
const poly = (g: CanvasRenderingContext2D, pts: number[]) => {
  g.beginPath();
  for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
  g.closePath();
  g.fill();
};

const GLYPHS: Record<Category, Draw> = {
  battle: (g) => {
    // Crossed swords.
    g.lineCap = 'round';
    for (const s of [1, -1]) {
      g.lineWidth = 0.17;
      g.beginPath();
      g.moveTo(-0.75 * s, -0.75);
      g.lineTo(0.5 * s, 0.5);
      g.stroke();
      g.lineWidth = 0.15;
      g.beginPath();
      g.moveTo(0.28 * s, 0.72);
      g.lineTo(0.72 * s, 0.28);
      g.stroke();
      g.beginPath();
      g.arc(0.78 * s, 0.78, 0.13, 0, Math.PI * 2);
      g.fill();
    }
  },
  polity: (g) => {
    // Crown.
    poly(g, [-0.8, 0.55, -0.85, -0.35, -0.42, 0.05, 0, -0.6, 0.42, 0.05, 0.85, -0.35, 0.8, 0.55]);
    g.fillRect(-0.8, 0.62, 1.6, 0.2);
    for (const [x, y] of [[-0.85, -0.45], [0, -0.72], [0.85, -0.45]]) {
      g.beginPath();
      g.arc(x!, y!, 0.13, 0, Math.PI * 2);
      g.fill();
    }
  },
  city: (g) => {
    // Castle.
    poly(g, [-0.85, 0.8, -0.85, -0.55, -0.62, -0.55, -0.62, -0.35, -0.42, -0.35, -0.42, -0.55, -0.2, -0.55, -0.2, -0.1,
      0.2, -0.1, 0.2, -0.55, 0.42, -0.55, 0.42, -0.35, 0.62, -0.35, 0.62, -0.55, 0.85, -0.55, 0.85, 0.8]);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(0, 0.5, 0.22, Math.PI, 0);
    g.lineTo(0.22, 0.8);
    g.lineTo(-0.22, 0.8);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  },
  monument: (g) => {
    // Temple front.
    poly(g, [-0.9, -0.35, 0, -0.9, 0.9, -0.35]);
    g.fillRect(-0.85, -0.3, 1.7, 0.14);
    for (const x of [-0.68, -0.23, 0.23, 0.68]) g.fillRect(x - 0.09, -0.1, 0.18, 0.72);
    g.fillRect(-0.95, 0.66, 1.9, 0.18);
  },
  religion: (g) => {
    // Domed sanctuary.
    g.beginPath();
    g.arc(0, 0.05, 0.62, Math.PI, 0);
    g.fill();
    g.fillRect(-0.75, 0.05, 1.5, 0.75);
    g.fillRect(-0.06, -0.95, 0.12, 0.45);
    g.beginPath();
    g.arc(0, -0.95, 0.12, 0, Math.PI * 2);
    g.fill();
  },
  person: (g) => {
    // Bust.
    g.beginPath();
    g.arc(0, -0.35, 0.36, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(0, 0.75, 0.72, 0.62, 0, Math.PI, 0);
    g.fill();
  },
  event: (g) => {
    // Banner on a pole.
    g.fillRect(-0.62, -0.9, 0.14, 1.8);
    poly(g, [-0.48, -0.85, 0.85, -0.6, 0.35, -0.3, 0.85, 0.0, -0.48, 0.1]);
  },
  discovery: (g) => {
    // Amphora, as dug up.
    g.fillRect(-0.2, -0.95, 0.4, 0.14);
    g.fillRect(-0.12, -0.85, 0.24, 0.25);
    g.beginPath();
    g.moveTo(-0.12, -0.6);
    g.bezierCurveTo(-0.75, -0.45, -0.7, 0.4, 0, 0.95);
    g.bezierCurveTo(0.7, 0.4, 0.75, -0.45, 0.12, -0.6);
    g.closePath();
    g.fill();
    g.lineWidth = 0.1;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * 0.12, -0.75);
      g.quadraticCurveTo(s * 0.55, -0.75, s * 0.4, -0.35);
      g.stroke();
    }
  },
  exploration: (g) => {
    // Compass rose.
    poly(g, [0, -0.95, 0.2, -0.2, 0.95, 0, 0.2, 0.2, 0, 0.95, -0.2, 0.2, -0.95, 0, -0.2, -0.2]);
  },
  fortification: (g) => {
    // Tower with battlements.
    poly(g, [-0.55, 0.85, -0.45, -0.45, -0.7, -0.45, -0.7, -0.9, -0.42, -0.9, -0.42, -0.7, -0.14, -0.7, -0.14, -0.9,
      0.14, -0.9, 0.14, -0.7, 0.42, -0.7, 0.42, -0.9, 0.7, -0.9, 0.7, -0.45, 0.45, -0.45, 0.55, 0.85]);
    g.globalCompositeOperation = 'destination-out';
    g.fillRect(-0.07, -0.25, 0.14, 0.32);
    g.beginPath();
    g.arc(0, 0.62, 0.2, Math.PI, 0);
    g.lineTo(0.2, 0.85);
    g.lineTo(-0.2, 0.85);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  },
  disaster: (g) => {
    // Lightning bolt.
    poly(g, [0.2, -0.95, -0.55, 0.12, -0.05, 0.12, -0.25, 0.95, 0.55, -0.15, 0.05, -0.15]);
  },
  trade: (g) => {
    // Balance.
    g.fillRect(-0.07, -0.7, 0.14, 1.45);
    g.fillRect(-0.85, -0.6, 1.7, 0.12);
    g.fillRect(-0.45, 0.72, 0.9, 0.14);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * 0.65 - 0.35, 0.05);
      g.lineTo(s * 0.65 + 0.35, 0.05);
      g.arc(s * 0.65, 0.05, 0.35, 0, Math.PI);
      g.fill();
      g.lineWidth = 0.06;
      g.beginPath();
      g.moveTo(s * 0.65 - 0.3, 0.05);
      g.lineTo(s * 0.65, -0.55);
      g.lineTo(s * 0.65 + 0.3, 0.05);
      g.stroke();
    }
  },
  art: (g) => {
    // Palette.
    g.beginPath();
    g.ellipse(0, 0, 0.92, 0.72, -0.3, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    for (const [x, y, r] of [[-0.45, -0.2, 0.14], [-0.05, -0.42, 0.14], [0.38, -0.3, 0.14], [0.35, 0.3, 0.2]]) {
      g.beginPath();
      g.arc(x!, y!, r!, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  },
  science: (g) => {
    // Flask.
    poly(g, [-0.2, -0.9, 0.2, -0.9, 0.2, -0.25, 0.8, 0.75, -0.8, 0.75, -0.2, -0.25]);
    g.fillRect(-0.32, -0.95, 0.64, 0.12);
  },
  nature: (g) => {
    // Pine tree.
    poly(g, [0, -0.95, 0.55, -0.2, 0.3, -0.2, 0.75, 0.45, -0.75, 0.45, -0.3, -0.2, -0.55, -0.2]);
    g.fillRect(-0.12, 0.45, 0.24, 0.45);
  },
  place: (g) => {
    g.beginPath();
    g.arc(0, 0, 0.42, 0, Math.PI * 2);
    g.fill();
  },
};

/** Marker geometry, shared with the label placement. */
export function markerGeometry(size: number): { width: number; height: number; tokenY: number } {
  const stem = Math.round(size * 0.55) + 5;
  return { width: size + 10, height: size + stem + 8, tokenY: size / 2 + 4 };
}

/**
 * Strategy-game style marker: a beveled token (shape and pictogram by
 * category, rim metal by importance) standing on a short pole with its
 * shadow on the ground. The anchor is the bottom center, on the location.
 */
export function markerIcon(category: Category, size: number, importance: number): HTMLCanvasElement {
  const tier = importance >= 0.7 ? 2 : importance >= 0.4 ? 1 : 0;
  const key = `${category}:${size}:${tier}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { width, height, tokenY } = markerGeometry(size);
  const c = document.createElement('canvas');
  c.width = Math.round(width * DPR);
  c.height = Math.round(height * DPR);
  const g = c.getContext('2d')!;
  g.scale(DPR, DPR);
  const cx = width / 2;
  const r = size / 2;
  const color = CATEGORY_COLORS[category];
  const [hi, mid, lo] = metal(importance);
  const shape = SHAPES[category] ?? 'circle';

  // Ground shadow and footing.
  const groundY = height - 3;
  g.save();
  g.fillStyle = 'rgba(0, 0, 0, 0.55)';
  g.filter = 'blur(1.5px)';
  g.beginPath();
  g.ellipse(cx, groundY, r * 0.55, 2.6, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.fillStyle = dark(color, 0.2);
  g.beginPath();
  g.ellipse(cx, groundY, 2.6, 1.4, 0, 0, Math.PI * 2);
  g.fill();

  // Pole.
  const pole = g.createLinearGradient(cx - 1.5, 0, cx + 1.5, 0);
  pole.addColorStop(0, lo);
  pole.addColorStop(0.45, hi);
  pole.addColorStop(1, lo);
  g.fillStyle = pole;
  g.fillRect(cx - 1.25, tokenY, 2.5, groundY - tokenY);

  // Token: drop shadow, metal rim, colored face, gloss.
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, 0.6)';
  g.shadowBlur = 4;
  g.shadowOffsetY = 2;
  shapePath(g, shape, cx, tokenY, r);
  const rim = g.createLinearGradient(0, tokenY - r, 0, tokenY + r);
  rim.addColorStop(0, hi);
  rim.addColorStop(0.5, mid);
  rim.addColorStop(1, lo);
  g.fillStyle = rim;
  g.fill();
  g.restore();

  const inner = r - Math.max(1.8, r * 0.16);
  shapePath(g, shape, cx, tokenY, inner);
  const face = g.createRadialGradient(cx - inner * 0.35, tokenY - inner * 0.45, inner * 0.1, cx, tokenY, inner * 1.25);
  face.addColorStop(0, light(color, 0.45));
  face.addColorStop(0.55, color);
  face.addColorStop(1, dark(color, 0.45));
  g.fillStyle = face;
  g.fill();

  g.save();
  shapePath(g, shape, cx, tokenY, inner);
  g.clip();
  const gloss = g.createLinearGradient(0, tokenY - inner, 0, tokenY);
  gloss.addColorStop(0, 'rgba(255, 255, 255, 0.38)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = gloss;
  g.beginPath();
  g.ellipse(cx, tokenY - inner * 0.55, inner * 1.1, inner * 0.62, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Pictogram, with an engraved shadow.
  const glyph = GLYPHS[category];
  const k = inner * 0.66;
  for (const [dy, fill] of [[0.9, 'rgba(10, 8, 6, 0.55)'], [0, '#fffaf0']] as const) {
    g.save();
    g.translate(cx, tokenY + dy);
    g.scale(k, k);
    g.fillStyle = fill;
    g.strokeStyle = fill;
    glyph(g);
    g.restore();
  }

  cache.set(key, c);
  return c;
}

/** Cluster marker: a stack of tokens with a count. */
export function clusterIcon(count: number): HTMLCanvasElement {
  const label = count > 99 ? '99+' : String(count);
  const key = `cluster:${label}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = count < 10 ? 28 : count < 50 ? 32 : 36;
  const w = size + 6;
  const h = size + 10;
  const c = document.createElement('canvas');
  c.width = Math.round(w * DPR);
  c.height = Math.round(h * DPR);
  const g = c.getContext('2d')!;
  g.scale(DPR, DPR);
  const r = size / 2;
  const cx = w / 2;
  // Two coins underneath suggest a pile.
  for (const [dy, a] of [[8, 0.55], [4, 0.8], [0, 1]] as const) {
    g.save();
    g.shadowColor = 'rgba(0, 0, 0, 0.5)';
    g.shadowBlur = 3;
    g.shadowOffsetY = 1.5;
    g.beginPath();
    g.arc(cx, r + 1 + dy, r - 1, 0, Math.PI * 2);
    const rim = g.createLinearGradient(0, dy, 0, size + dy);
    rim.addColorStop(0, `rgba(255, 236, 180, ${a})`);
    rim.addColorStop(1, `rgba(122, 83, 23, ${a})`);
    g.fillStyle = rim;
    g.fill();
    g.restore();
  }
  g.beginPath();
  g.arc(cx, r + 1, r - 3.5, 0, Math.PI * 2);
  const face = g.createRadialGradient(cx - r * 0.3, r * 0.6, 1, cx, r + 1, r);
  face.addColorStop(0, '#2a2f3a');
  face.addColorStop(1, '#0e1015');
  g.fillStyle = face;
  g.fill();
  g.fillStyle = '#f3e6c4';
  g.font = `700 ${count > 99 ? 10.5 : 12.5}px 'Inter Variable', system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, cx, r + 1.5);
  cache.set(key, c);
  return c;
}

/** Token diameter from importance (0..1), in whole pixels. */
export function sizeFor(importance: number): number {
  return Math.round(14 + importance * importance * 14);
}

export { DPR };
