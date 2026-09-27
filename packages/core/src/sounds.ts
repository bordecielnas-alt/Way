import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Sounds the owner imported in the Réglages page, one per kind of point
// (battle, polity…), replacing the synthesized one. Kept in /data/sounds.

export const SOUND_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};
const EXT_TYPE: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
export const SOUND_MAX_BYTES = 3 * 1024 * 1024;
const KIND = /^[a-z]{3,20}$/;

export class SoundFiles {
  constructor(private dir: string) {}

  private find(kind: string): string | null {
    if (!KIND.test(kind) || !existsSync(this.dir)) return null;
    const f = readdirSync(this.dir).find((n) => n.startsWith(`${kind}.`) && EXT_TYPE[n.slice(kind.length + 1)]);
    return f ? join(this.dir, f) : null;
  }

  /** kind -> version (changes with each import, for caching). */
  list(): Record<string, string> {
    if (!existsSync(this.dir)) return {};
    const out: Record<string, string> = {};
    for (const n of readdirSync(this.dir)) {
      const [kind, ext] = n.split('.');
      if (kind && ext && KIND.test(kind) && EXT_TYPE[ext]) out[kind] = String(Math.round(statSync(join(this.dir, n)).mtimeMs));
    }
    return out;
  }

  read(kind: string): { data: Buffer; type: string } | null {
    const f = this.find(kind);
    if (!f) return null;
    return { data: readFileSync(f), type: EXT_TYPE[f.slice(f.lastIndexOf('.') + 1)]! };
  }

  save(kind: string, type: string, data: Buffer): void {
    const ext = SOUND_TYPES[type];
    if (!KIND.test(kind) || !ext) throw new Error('format audio non pris en charge');
    if (data.length > SOUND_MAX_BYTES) throw new Error('fichier trop lourd (3 Mo au plus)');
    mkdirSync(this.dir, { recursive: true });
    this.remove(kind);
    const dest = join(this.dir, `${kind}.${ext}`);
    writeFileSync(`${dest}.part`, data);
    renameSync(`${dest}.part`, dest);
  }

  remove(kind: string): void {
    const f = this.find(kind);
    if (f) rmSync(f);
  }
}
