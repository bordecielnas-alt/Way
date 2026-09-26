import type { Category } from '@way/shared';

export const CATEGORY_COLORS: Record<Category, string> = {
  battle: '#e0594a',
  city: '#e8c468',
  polity: '#b18be0',
  monument: '#d9905a',
  religion: '#7fb3e0',
  person: '#e07fb0',
  event: '#eeeae0',
  discovery: '#a3cc6b',
  disaster: '#ff8a3d',
  trade: '#5cc8b8',
  art: '#dd7fd4',
  science: '#6fa0ff',
  nature: '#63b86c',
  place: '#a9a39a',
};

const cache = new Map<string, HTMLCanvasElement>();
const DPR = Math.min(2, window.devicePixelRatio || 1);

/** Round marker: colored disc, dark rim, soft halo. Drawn at device resolution. */
export function markerIcon(category: Category, size: number): HTMLCanvasElement {
  const key = `${category}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pad = 6;
  const px = (size + pad * 2) * DPR;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  g.scale(DPR, DPR);
  const r = size / 2;
  const cx = r + pad;
  const color = CATEGORY_COLORS[category];
  const halo = g.createRadialGradient(cx, cx, r * 0.6, cx, cx, r + pad);
  halo.addColorStop(0, color + '66');
  halo.addColorStop(1, color + '00');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(cx, cx, r + pad, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1.6;
  g.strokeStyle = 'rgba(8,10,14,0.85)';
  g.stroke();
  g.beginPath();
  g.arc(cx, cx, r * 0.32, 0, Math.PI * 2);
  g.fillStyle = 'rgba(8,10,14,0.55)';
  g.fill();
  cache.set(key, c);
  return c;
}

/** Cluster marker with a count. */
export function clusterIcon(count: number): HTMLCanvasElement {
  const label = count > 99 ? '99+' : String(count);
  const key = `cluster:${label}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = count < 10 ? 26 : count < 50 ? 30 : 34;
  const px = size * DPR;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  g.scale(DPR, DPR);
  const r = size / 2;
  g.beginPath();
  g.arc(r, r, r - 1.5, 0, Math.PI * 2);
  g.fillStyle = 'rgba(14,16,21,0.88)';
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = '#d9a441';
  g.stroke();
  g.fillStyle = '#ece4d2';
  g.font = `600 ${count > 99 ? 10 : 12}px 'Inter Variable', system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, r, r + 0.5);
  cache.set(key, c);
  return c;
}

/** Marker diameter from importance (0..1). */
export function sizeFor(importance: number): number {
  return Math.round(9 + importance * importance * 13);
}

export { DPR };
