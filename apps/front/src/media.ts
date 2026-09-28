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

