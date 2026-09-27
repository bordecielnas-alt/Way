// Figures for people and armies on the map, drawn on canvas: a painted
// figurine, a portrait medallion or a banner, with a sign of what they are
// doing (crown, crossed swords, book, hourglass, walking staff…).

import type { ActivityKind } from '@way/shared';

export type FigureStyle = 'figurine' | 'medallion' | 'banner';
export const FIGURE_STYLES: { value: FigureStyle; label: string }[] = [
  { value: 'figurine', label: 'Figurine' },
  { value: 'medallion', label: 'Médaillon' },
  { value: 'banner', label: 'Étendard' },
];
export const PALETTE = ['#d9a441', '#c8554f', '#5b8fd1', '#8fbf5a', '#9a72c9', '#4fb3c4', '#e0864a', '#d673b1'];

const W = 72;
const H = 88;
const INK = '#1a140e';
const GOLD = '#e8c26a';

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s-]/gu, '').split(/[\s-]+/).filter((p) => p.length > 1 && !/^(de|du|des|la|le|of|von|van|d)$/i.test(p));
  return (parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || name.slice(0, 1).toUpperCase());
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

// ---------- small signs of activity ----------

function crown(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.beginPath();
  g.moveTo(cx - s, cy + s * 0.55);
  g.lineTo(cx - s, cy - s * 0.35);
  g.lineTo(cx - s * 0.5, cy + s * 0.1);
  g.lineTo(cx, cy - s * 0.6);
  g.lineTo(cx + s * 0.5, cy + s * 0.1);
  g.lineTo(cx + s, cy - s * 0.35);
  g.lineTo(cx + s, cy + s * 0.55);
  g.closePath();
  g.fillStyle = GOLD;
  g.fill();
  g.lineWidth = 1.2;
  g.strokeStyle = INK;
  g.stroke();
}

function swords(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.lineCap = 'round';
  for (const dir of [1, -1]) {
    g.beginPath();
    g.moveTo(cx - s * dir, cy + s);
    g.lineTo(cx + s * dir, cy - s);
    g.strokeStyle = INK;
    g.lineWidth = 3.4;
    g.stroke();
    g.strokeStyle = '#e9edf2';
    g.lineWidth = 1.8;
    g.stroke();
    // guard
    g.beginPath();
    g.moveTo(cx - s * dir * 0.62 - s * 0.3, cy + s * 0.62 - s * 0.3 * dir);
    g.lineTo(cx - s * dir * 0.62 + s * 0.3, cy + s * 0.62 + s * 0.3 * dir);
    g.strokeStyle = GOLD;
    g.lineWidth = 2;
    g.stroke();
  }
}

function book(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.fillStyle = '#f3ead6';
  g.strokeStyle = INK;
  g.lineWidth = 1.2;
  for (const dir of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx, cy - s * 0.5);
    g.quadraticCurveTo(cx + dir * s * 0.5, cy - s * 0.75, cx + dir * s, cy - s * 0.55);
    g.lineTo(cx + dir * s, cy + s * 0.6);
    g.quadraticCurveTo(cx + dir * s * 0.5, cy + s * 0.4, cx, cy + s * 0.65);
    g.closePath();
    g.fill();
    g.stroke();
  }
}

function hourglass(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.beginPath();
  g.moveTo(cx - s * 0.7, cy - s);
  g.lineTo(cx + s * 0.7, cy - s);
  g.lineTo(cx, cy);
  g.lineTo(cx + s * 0.7, cy + s);
  g.lineTo(cx - s * 0.7, cy + s);
  g.lineTo(cx, cy);
  g.closePath();
  g.fillStyle = '#f0d9a0';
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1.3;
  g.stroke();
}

function star(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.45 : s;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  g.closePath();
  g.fillStyle = GOLD;
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.stroke();
}

function cross(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.fillStyle = '#d8d8d8';
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.beginPath();
  g.rect(cx - s * 0.2, cy - s, s * 0.4, s * 2);
  g.rect(cx - s * 0.65, cy - s * 0.45, s * 1.3, s * 0.4);
  g.fill();
  g.stroke();
}

function rings(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.lineWidth = 2;
  g.strokeStyle = GOLD;
  for (const dx of [-0.35, 0.35]) {
    g.beginPath();
    g.arc(cx + dx * s, cy + 0.1 * s, s * 0.55, 0, Math.PI * 2);
    g.stroke();
  }
}

function scroll(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.fillStyle = '#efe2c2';
  g.strokeStyle = INK;
  g.lineWidth = 1.1;
  g.beginPath();
  g.rect(cx - s * 0.7, cy - s * 0.75, s * 1.4, s * 1.5);
  g.fill();
  g.stroke();
  g.beginPath();
  for (const y of [-0.3, 0.05, 0.4]) {
    g.moveTo(cx - s * 0.4, cy + y * s);
    g.lineTo(cx + s * 0.4, cy + y * s);
  }
  g.stroke();
}

function boot(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  // An arrow on the road: travelling.
  g.beginPath();
  g.moveTo(cx - s, cy + s * 0.25);
  g.lineTo(cx + s * 0.2, cy + s * 0.25);
  g.lineTo(cx + s * 0.2, cy + s * 0.7);
  g.lineTo(cx + s, cy);
  g.lineTo(cx + s * 0.2, cy - s * 0.7);
  g.lineTo(cx + s * 0.2, cy - s * 0.25);
  g.lineTo(cx - s, cy - s * 0.25);
  g.closePath();
  g.fillStyle = '#e6dcc4';
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.stroke();
}

function house(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.beginPath();
  g.moveTo(cx - s * 0.8, cy);
  g.lineTo(cx, cy - s * 0.8);
  g.lineTo(cx + s * 0.8, cy);
  g.lineTo(cx + s * 0.6, cy);
  g.lineTo(cx + s * 0.6, cy + s * 0.8);
  g.lineTo(cx - s * 0.6, cy + s * 0.8);
  g.lineTo(cx - s * 0.6, cy);
  g.closePath();
  g.fillStyle = '#e6dcc4';
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1.1;
  g.stroke();
}

const SIGNS: Record<ActivityKind, (g: CanvasRenderingContext2D, cx: number, cy: number, s: number) => void> = {
  birth: star, death: cross, study: book, stay: house, work: scroll, reign: crown, office: scroll,
  battle: swords, coronation: crown, marriage: rings, event: scroll, travel: boot, wait: hourglass,
};

/** Round badge with the activity's sign. */
function badge(g: CanvasRenderingContext2D, kind: ActivityKind, cx: number, cy: number): void {
  g.beginPath();
  g.arc(cx, cy, 10, 0, Math.PI * 2);
  g.fillStyle = kind === 'battle' ? '#7a1f1a' : kind === 'death' ? '#333' : '#1d1a15';
  g.fill();
  g.lineWidth = 1.6;
  g.strokeStyle = GOLD;
  g.stroke();
  SIGNS[kind](g, cx, cy, 5.5);
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  return [c, g];
}

function groundShadow(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.ellipse(W / 2, H - 5, 17, 4, 0, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0, 0, 0, 0.4)';
  g.fill();
}

function figurine(g: CanvasRenderingContext2D, color: string, kind: ActivityKind): void {
  const cx = W / 2;
  const dead = kind === 'death';
  const body = dead ? '#8a857c' : color;
  groundShadow(g);
  // plinth
  g.beginPath();
  g.ellipse(cx, H - 9, 15, 5, 0, 0, Math.PI * 2);
  g.fillStyle = '#3b2a1b';
  g.fill();
  g.strokeStyle = GOLD;
  g.lineWidth = 1.2;
  g.stroke();
  // robe
  const grad = g.createLinearGradient(cx - 14, 0, cx + 14, 0);
  grad.addColorStop(0, shade(body, -0.35));
  grad.addColorStop(0.45, shade(body, 0.15));
  grad.addColorStop(1, shade(body, -0.45));
  g.beginPath();
  g.moveTo(cx - 13, H - 10);
  g.quadraticCurveTo(cx - 12, H - 30, cx - 8, H - 44);
  g.lineTo(cx + 8, H - 44);
  g.quadraticCurveTo(cx + 12, H - 30, cx + 13, H - 10);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1.4;
  g.stroke();
  // belt
  g.fillStyle = shade(body, -0.55);
  g.fillRect(cx - 10, H - 32, 20, 3);
  // head
  g.beginPath();
  g.arc(cx, H - 50, 7.5, 0, Math.PI * 2);
  g.fillStyle = dead ? '#bbb4a8' : '#efcfa9';
  g.fill();
  g.stroke();
  // held items
  if (kind === 'reign' || kind === 'coronation') crown(g, cx, H - 59, 6.5);
  if (kind === 'battle') {
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx + 9, H - 34);
    g.lineTo(cx + 22, H - 58);
    g.strokeStyle = INK;
    g.lineWidth = 3.4;
    g.stroke();
    g.strokeStyle = '#e9edf2';
    g.lineWidth = 1.8;
    g.stroke();
    g.beginPath();
    g.arc(cx - 12, H - 30, 7, 0, Math.PI * 2);
    g.fillStyle = shade(body, -0.2);
    g.fill();
    g.strokeStyle = GOLD;
    g.lineWidth = 1.5;
    g.stroke();
  }
  if (kind === 'study') book(g, cx, H - 30, 7);
  if (kind === 'travel') {
    g.beginPath();
    g.moveTo(cx + 13, H - 8);
    g.lineTo(cx + 17, H - 50);
    g.strokeStyle = '#6b4a2a';
    g.lineWidth = 2.4;
    g.lineCap = 'round';
    g.stroke();
  }
  badge(g, kind, W - 12, 13);
}

function medallion(g: CanvasRenderingContext2D, color: string, kind: ActivityKind, text: string, portrait: HTMLImageElement | null): void {
  const cx = W / 2;
  const cy = 34;
  groundShadow(g);
  // stem to the ground
  g.beginPath();
  g.moveTo(cx - 6, cy + 20);
  g.lineTo(cx, H - 6);
  g.lineTo(cx + 6, cy + 20);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1.2;
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, 25, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1.4;
  g.strokeStyle = INK;
  g.stroke();
  g.save();
  g.beginPath();
  g.arc(cx, cy, 21, 0, Math.PI * 2);
  g.clip();
  if (portrait) {
    const k = Math.max(42 / portrait.naturalWidth, 42 / portrait.naturalHeight);
    const w = portrait.naturalWidth * k;
    const h = portrait.naturalHeight * k;
    g.drawImage(portrait, cx - w / 2, cy - 21 - Math.max(0, (h - 42) * 0.15), w, h);
    if (kind === 'death') {
      g.fillStyle = 'rgba(40, 40, 40, 0.55)';
      g.fillRect(cx - 21, cy - 21, 42, 42);
    }
  } else {
    g.fillStyle = '#1d1a15';
    g.fillRect(cx - 21, cy - 21, 42, 42);
    g.fillStyle = GOLD;
    g.font = '600 18px "EB Garamond", Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cx, cy + 1);
  }
  g.restore();
  badge(g, kind, W - 12, 13);
}

function banner(g: CanvasRenderingContext2D, color: string, kind: ActivityKind, text: string): void {
  groundShadow(g);
  const x = 18;
  g.beginPath();
  g.moveTo(x, H - 5);
  g.lineTo(x, 8);
  g.strokeStyle = '#5b3f22';
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.stroke();
  g.beginPath();
  g.arc(x, 7, 3, 0, Math.PI * 2);
  g.fillStyle = GOLD;
  g.fill();
  const flag = kind === 'death' ? '#6f6a62' : color;
  g.beginPath();
  g.moveTo(x + 1, 12);
  g.lineTo(x + 44, 12);
  g.lineTo(x + 36, 29);
  g.lineTo(x + 44, 46);
  g.lineTo(x + 1, 46);
  g.closePath();
  const grad = g.createLinearGradient(x, 12, x + 44, 46);
  grad.addColorStop(0, shade(flag, 0.15));
  grad.addColorStop(1, shade(flag, -0.35));
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1.3;
  g.stroke();
  g.fillStyle = '#fbf3e0';
  g.font = '600 17px "EB Garamond", Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x + 19, 30);
  badge(g, kind, W - 12, H - 26);
}

const cache = new Map<string, HTMLCanvasElement>();
const ids = new WeakMap<HTMLCanvasElement, string>();

/** Stable id of a drawn figure: the billboard atlas keeps one copy per id. */
export function figureId(c: HTMLCanvasElement): string {
  return ids.get(c) ?? '';
}

/** A person's figure; `portrait` is used by the medallion (initials otherwise). */
export function personFigure(style: FigureStyle, color: string, kind: ActivityKind, name: string, portrait: HTMLImageElement | null = null): HTMLCanvasElement {
  const key = `${style}|${color}|${kind}|${name}|${portrait ? portrait.src : ''}`;
  let c = cache.get(key);
  if (!c) {
    const [cv, g] = canvas();
    if (style === 'medallion') medallion(g, color, kind, initials(name), portrait);
    else if (style === 'banner') banner(g, color, kind, initials(name));
    else figurine(g, color, kind);
    c = cv;
    cache.set(key, c);
    ids.set(c, key);
  }
  return c;
}

/**
 * An army: three soldiers with spears and shields in the side's color, under
 * its banner; with `flag` (Blasons → Armées), the banner is the side's flag.
 */
export function armyFigure(color: string, kind: ActivityKind, flag: HTMLImageElement | null = null): HTMLCanvasElement {
  const key = `army|${color}|${kind}|${flag ? flag.src : ''}`;
  let c = cache.get(key);
  if (c) return c;
  const [cv, g] = canvas();
  groundShadow(g);
  // banner behind
  g.beginPath();
  g.moveTo(W / 2, H - 20);
  g.lineTo(W / 2, flag ? 3 : 6);
  g.strokeStyle = '#5b3f22';
  g.lineWidth = 2.2;
  g.stroke();
  if (flag) {
    // The flag itself, a little waving, framed in ink.
    const h = 20;
    const w = Math.min(34, Math.max(20, (h * flag.naturalWidth) / Math.max(1, flag.naturalHeight)));
    const x = W / 2 + 1;
    const y = 4;
    g.save();
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + w / 2, y - 2, x + w, y + 1);
    g.lineTo(x + w, y + h + 1);
    g.quadraticCurveTo(x + w / 2, y + h - 2, x, y + h);
    g.closePath();
    g.clip();
    g.drawImage(flag, x, y - 1, w, h + 3);
    g.restore();
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + w / 2, y - 2, x + w, y + 1);
    g.lineTo(x + w, y + h + 1);
    g.quadraticCurveTo(x + w / 2, y + h - 2, x, y + h);
    g.closePath();
    g.strokeStyle = INK;
    g.lineWidth = 1.1;
    g.stroke();
  } else {
    g.beginPath();
    g.moveTo(W / 2 + 1, 8);
    g.lineTo(W / 2 + 22, 8);
    g.lineTo(W / 2 + 16, 16);
    g.lineTo(W / 2 + 22, 24);
    g.lineTo(W / 2 + 1, 24);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1.1;
    g.stroke();
  }
  const soldier = (x: number, y: number, s: number) => {
    // spear
    g.beginPath();
    g.moveTo(x + 7 * s, y + 2 * s);
    g.lineTo(x + (kind === 'battle' ? 16 : 9) * s, y - 30 * s);
    g.strokeStyle = '#6b4a2a';
    g.lineWidth = 1.8;
    g.stroke();
    // body
    g.beginPath();
    g.moveTo(x - 6 * s, y);
    g.lineTo(x - 4 * s, y - 18 * s);
    g.lineTo(x + 4 * s, y - 18 * s);
    g.lineTo(x + 6 * s, y);
    g.closePath();
    g.fillStyle = shade(color, -0.3);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1.1;
    g.stroke();
    // helmet
    g.beginPath();
    g.arc(x, y - 22 * s, 4.5 * s, Math.PI, 0);
    g.lineTo(x + 4.5 * s, y - 20 * s);
    g.lineTo(x - 4.5 * s, y - 20 * s);
    g.closePath();
    g.fillStyle = '#9aa3ad';
    g.fill();
    g.stroke();
    // shield
    g.beginPath();
    g.moveTo(x - 9 * s, y - 15 * s);
    g.lineTo(x - 1 * s, y - 15 * s);
    g.lineTo(x - 1 * s, y - 7 * s);
    g.quadraticCurveTo(x - 5 * s, y - 1 * s, x - 9 * s, y - 7 * s);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.strokeStyle = GOLD;
    g.lineWidth = 1.2;
    g.stroke();
  };
  soldier(W / 2 - 16, H - 10, 0.85);
  soldier(W / 2 + 14, H - 10, 0.85);
  soldier(W / 2, H - 6, 1);
  badge(g, kind, W - 12, H - 30);
  cache.set(key, cv);
  ids.set(cv, key);
  return cv;
}

/** Two armies meeting: crossed swords over a burst of fire. */
export function clashFigure(): HTMLCanvasElement {
  const key = 'clash';
  let c = cache.get(key);
  if (c) return c;
  const S = 64;
  c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  const cx = S / 2;
  const cy = S / 2;
  // burst
  const glow = g.createRadialGradient(cx, cy, 2, cx, cy, 30);
  glow.addColorStop(0, 'rgba(255, 214, 120, 0.95)');
  glow.addColorStop(0.45, 'rgba(226, 92, 40, 0.75)');
  glow.addColorStop(1, 'rgba(160, 30, 20, 0)');
  g.beginPath();
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 13 : i % 4 ? 24 : 30;
    const a = (i * Math.PI) / 12;
    g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  g.closePath();
  g.fillStyle = glow;
  g.fill();
  // disc
  g.beginPath();
  g.arc(cx, cy, 15, 0, Math.PI * 2);
  g.fillStyle = '#7a1f1a';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = GOLD;
  g.stroke();
  swords(g, cx, cy, 9);
  cache.set(key, c);
  ids.set(c, key);
  return c;
}
