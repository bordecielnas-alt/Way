import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBytes, HttpError } from '@way/providers';

// Images from Wikimedia (portraits, coats of arms, flags, photos) kept on
// the server: each one is asked from Wikimedia once, then served from disk
// (same origin, so they can also be painted on the map). The least recently
// used files go first when the budget is reached.

export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
/** Wikimedia's standard thumbnail widths: other widths are rate-limited. */
const WIDTHS = [60, 120, 250, 330, 500, 960, 1280];
const TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
};
const EXT_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));
const DAY = 86_400_000;

/** What to fetch: a Commons file at a width, or a file already on upload.wikimedia.org. */
export type MediaRequest = { file: string; width: number } | { url: string };

/** Nearest standard width: fewer variants of one image, more cache hits. */
export function snapWidth(w: number): number {
  return WIDTHS.find((x) => x >= w) ?? WIDTHS[WIDTHS.length - 1]!;
}

/**
 * Where to fetch a request, best first, or [] when it is not a Wikimedia
 * image. A Commons file is asked straight from the image servers (its path
 * comes from the MD5 of its name): the wiki itself limits bursts. Its
 * thumbnail comes first, then the original (small images have no larger
 * thumbnail).
 */
export function mediaSources(r: MediaRequest): string[] {
  if ('file' in r) {
    if (!r.file || r.file.length > 240 || /[/\\#?<>[\]{}|]/.test(r.file)) return [];
    const name = r.file.trim().replace(/ /g, '_');
    const md5 = createHash('md5').update(name).digest('hex');
    const dir = `${md5[0]}/${md5.slice(0, 2)}`;
    const enc = encodeURIComponent(name);
    // Drawings are rasterized: their thumbnails are PNG.
    const thumb = /\.svg$/i.test(name) ? `${enc}.png` : /\.tiff?$/i.test(name) ? `lossy-page1-${enc}.jpg` : enc;
    return [
      `https://upload.wikimedia.org/wikipedia/commons/thumb/${dir}/${enc}/${snapWidth(r.width)}px-${thumb}`,
      ...(/\.tiff?$/i.test(name) ? [] : [`https://upload.wikimedia.org/wikipedia/commons/${dir}/${enc}`]),
    ];
  }
  const u = URL.parse(r.url);
  return u && u.protocol === 'https:' && u.host === 'upload.wikimedia.org' ? [u.toString()] : [];
}

/** The first source that answers; a missing thumbnail (4xx) moves on to the next one. */
async function firstOf(sources: string[]): Promise<{ data: Buffer; type: string }> {
  for (let i = 0; ; i++) {
    try {
      return await fetchBytes(sources[i]!, MEDIA_MAX_BYTES);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      const missing = status >= 400 && status < 500 && status !== 429;
      if (!missing || i + 1 >= sources.length) throw e;
    }
  }
}

interface Entry { size: number; used: number }

export class MediaCache {
  private entries = new Map<string, Entry>();
  private total = 0;
  private inflight = new Map<string, Promise<{ data: Buffer; type: string }>>();
  private scanned: Promise<void>;

  /**
   * `budget` is the disk share for images, in bytes; `keep` says whether
   * images are stored at all (otherwise they are only relayed).
   */
  constructor(private dir: string, private budget: () => number, private keep: () => boolean) {
    this.scanned = new Promise((done) => setImmediate(() => {
      this.scan();
      done();
    }));
  }

  /** Reads what is already on disk (in the background at start). */
  private scan(): void {
    try {
      for (const sub of readdirSync(this.dir)) {
        for (const name of readdirSync(join(this.dir, sub))) {
          if (name.endsWith('.part')) continue;
          const st = statSync(join(this.dir, sub, name));
          this.entries.set(name, { size: st.size, used: st.mtimeMs });
          this.total += st.size;
        }
      }
    } catch {
      /* no cache yet */
    }
  }

  get bytes(): number {
    return this.total;
  }

  get count(): number {
    return this.entries.size;
  }

  async get(req: MediaRequest): Promise<{ data: Buffer; type: string } | null> {
    const sources = mediaSources(req);
    if (!sources.length) return null;
    await this.scanned;
    const hash = createHash('sha1').update(sources[0]!).digest('hex');
    const name = this.find(hash);
    if (name) {
      const e = this.entries.get(name)!;
      const path = join(this.dir, hash.slice(0, 2), name);
      try {
        const data = readFileSync(path);
        // Recently used: survives eviction (the file date is touched at most daily).
        if (Date.now() - e.used > DAY) utimesSync(path, new Date(), new Date());
        e.used = Date.now();
        return { data, type: EXT_TYPE[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream' };
      } catch {
        this.forget(name);
      }
    }
    let p = this.inflight.get(hash);
    if (!p) {
      p = firstOf(sources)
        .then((got) => {
          const ext = TYPES[got.type];
          if (!ext) throw new Error(`not an image: ${got.type}`);
          if (this.keep()) this.store(hash, ext, got.data);
          return got;
        })
        .finally(() => this.inflight.delete(hash));
      this.inflight.set(hash, p);
    }
    return p;
  }

  private find(hash: string): string | null {
    for (const ext of Object.values(TYPES)) if (this.entries.has(`${hash}.${ext}`)) return `${hash}.${ext}`;
    return null;
  }

  private store(hash: string, ext: string, data: Buffer): void {
    try {
      const sub = join(this.dir, hash.slice(0, 2));
      mkdirSync(sub, { recursive: true });
      const path = join(sub, `${hash}.${ext}`);
      writeFileSync(`${path}.part`, data);
      renameSync(`${path}.part`, path);
      this.entries.set(`${hash}.${ext}`, { size: data.length, used: Date.now() });
      this.total += data.length;
      if (this.total > this.budget()) this.evict();
    } catch (e) {
      console.warn('[media] could not store an image:', (e as Error).message);
    }
  }

  /** Least recently used images go until the cache is back under 90% of its budget. */
  evict(): number {
    const target = this.budget() * 0.9;
    if (this.total <= target) return 0;
    const byAge = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used);
    let n = 0;
    for (const [name] of byAge) {
      if (this.total <= target) break;
      this.forget(name);
      n++;
    }
    return n;
  }

  private forget(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    try {
      rmSync(join(this.dir, name.slice(0, 2), name), { force: true });
    } catch {
      /* already gone */
    }
    this.entries.delete(name);
    this.total -= e.size;
  }

  /** Empties the image cache (Réglages page). */
  clear(): void {
    for (const name of [...this.entries.keys()]) this.forget(name);
  }
}
