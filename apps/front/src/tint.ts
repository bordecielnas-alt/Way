// Colors taken from coats of arms and flags: a realm (and its armies) wears
// the dominant color of its emblem on the map.

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * The dominant color of an emblem (RGBA pixels): the largest area of one
 * hue, leaving out white, black, greys and silver (the field of most arms
 * and the outlines). Toned so it reads on the map: never too pale, too dark
 * or too dull. Null when the emblem has no real color (all silver and sable).
 */
export function dominantColor(rgba: Uint8ClampedArray | number[]): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    if (rgba[i + 3]! < 128) continue;
    opaque++;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.28 || l < 0.12 || l > 0.9) continue;
    // 18 hues × 3 shades: gold and brown, or azure and navy, stay apart. Hues are shifted by
    // 10° so that reds (on both sides of 0°) fall in one slice.
    const k = Math.floor(((h + 10) % 360) / 20) * 3 + (l < 0.35 ? 0 : l < 0.62 ? 1 : 2);
    const c = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += r;
    c.g += g;
    c.b += b;
    buckets.set(k, c);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of buckets.values()) if (!best || c.n > best.n) best = c;
  if (!best || best.n < opaque * 0.06) return null;
  const [h, s, l] = rgbToHsl(best.r / best.n, best.g / best.n, best.b / best.n);
  return hslToHex(h, Math.max(0.45, Math.min(0.85, s)), Math.max(0.38, Math.min(0.58, l)));
}

/** A lighter tone of a color, for borders drawn over the realm's fill. */
export function lighter(hex: string, t = 0.55): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (sh: number) => Math.round(((n >> sh) & 255) * (1 - t) + 255 * t);
  return `#${[ch(16), ch(8), ch(0)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** The color with an alpha channel (0..1). */
export function withAlpha(hex: string, a: number): string {
  return `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
}
