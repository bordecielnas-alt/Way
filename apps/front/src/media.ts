// Wikimedia images go through the server, which keeps them: each one is
// asked from Wikimedia once, whoever looks at it afterwards.

const FILE_PATH = /^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/([^?#]+)(?:\?width=(\d+))?$/;

/** The server's copy of a Wikimedia image URL (other URLs are left as they are). */
export function viaServer(url: string): string;
export function viaServer(url: string | null): string | null;
export function viaServer(url: string | null): string | null {
  if (!url) return url;
  const m = FILE_PATH.exec(url);
  if (m) return commonsImage(decodeURIComponent(m[1]!).replace(/_/g, ' '), Number(m[2] ?? 800));
  if (/^https:\/\/upload\.wikimedia\.org\//.test(url)) return `/api/media?${new URLSearchParams({ u: url })}`;
  return url;
}

/** A Commons file (coat of arms, flag) at about `width` pixels, from the server. */
export function commonsImage(file: string, width: number): string {
  return `/api/media?${new URLSearchParams({ f: file, w: String(width) })}`;
}

const images = new Map<string, Promise<HTMLImageElement | null>>();

/** Loads an image once (same origin: it can be painted on canvases). */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((done) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => done(img);
      img.onerror = () => {
        images.delete(src); // asked again next time (Wikimedia may have been busy)
        done(null);
      };
      img.src = src;
    });
    images.set(src, p);
    if (images.size > 800) images.delete(images.keys().next().value!);
  }
  return p;
}

/** Main color of a flag: its most saturated frequent color, for an army's banner and soldiers. */
export function dominantColor(img: HTMLImageElement): string | null {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 16;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  try {
    g.drawImage(img, 0, 0, 24, 16);
    const d = g.getImageData(0, 0, 24, 16).data;
    const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 128) continue;
      const r = d[i]!, gr = d[i + 1]!, b = d[i + 2]!;
      const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
      // White and black fields say little about a side: colors win.
      const sat = max ? (max - min) / max : 0;
      const weight = sat > 0.25 && max > 50 ? 3 : 1;
      const k = ((r >> 5) << 6) | ((gr >> 5) << 3) | (b >> 5);
      const bin = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n += weight;
      bin.r += r * weight;
      bin.g += gr * weight;
      bin.b += b * weight;
      bins.set(k, bin);
    }
    const best = [...bins.values()].sort((a, b) => b.n - a.n)[0];
    if (!best) return null;
    const hex = (v: number) => Math.round(v / best.n).toString(16).padStart(2, '0');
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
  } catch {
    return null; // tainted canvas: no color
  }
}
