import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Settings edited from the web app (Réglages page). They sit on top of the
// environment: a value saved here wins, a value removed here falls back to
// the container's variables.

export interface SettingsData {
  /** Level-2 switch; undefined follows LEVEL2. */
  level2?: boolean;
  /** Provider variables (API keys, URLs, <ID>_MODEL). */
  env: Record<string, string>;
  /** Provider ids turned off by hand. */
  disabled: string[];
}

const RELOAD_MS = 3000;

export class SettingsFile {
  private data: SettingsData = { env: {}, disabled: [] };
  private mtime = 0;
  private checked = 0;

  constructor(private file: string | null) {
    this.reload();
  }

  /** Current settings; re-read when another process (worker) saved them. */
  get(): SettingsData {
    if (this.file && Date.now() - this.checked > RELOAD_MS) this.reload();
    return this.data;
  }

  save(data: SettingsData): void {
    this.data = data;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600); // keys inside: owner only
    } catch {
      /* not supported (Windows) */
    }
    this.mtime = statSync(this.file).mtimeMs;
  }

  private reload(): void {
    this.checked = Date.now();
    if (!this.file || !existsSync(this.file)) return;
    const mtime = statSync(this.file).mtimeMs;
    if (mtime === this.mtime) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SettingsData>;
      this.data = {
        level2: typeof raw.level2 === 'boolean' ? raw.level2 : undefined,
        env: Object.fromEntries(Object.entries(raw.env ?? {}).filter(([, v]) => typeof v === 'string' && v)),
        disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x) => typeof x === 'string') : [],
      };
      this.mtime = mtime;
    } catch (e) {
      console.warn('[settings] unreadable file, keeping previous values:', (e as Error).message);
    }
  }
}
