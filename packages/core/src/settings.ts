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
  /** Interface and exploration preferences. */
  ui?: UiSettings;
}

export interface UiSettings {
  sounds: boolean;
  volume: number;
  /** Resting the pointer on a point opens its card. */
  hoverOpen: boolean;
  /** "Pendant ce temps" skips events spanning more years than this. */
  meanwhileMaxSpan: number;
}

export const DEFAULT_UI: UiSettings = { sounds: true, volume: 0.6, hoverOpen: false, meanwhileMaxSpan: 20 };

/** Fills missing or invalid fields with defaults (older settings files, partial updates). */
export function normalizeUi(raw: Partial<UiSettings> | undefined): UiSettings {
  const u: Partial<UiSettings> = raw && typeof raw === 'object' ? raw : {};
  return {
    sounds: typeof u.sounds === 'boolean' ? u.sounds : DEFAULT_UI.sounds,
    volume: typeof u.volume === 'number' ? Math.min(1, Math.max(0, u.volume)) : DEFAULT_UI.volume,
    hoverOpen: typeof u.hoverOpen === 'boolean' ? u.hoverOpen : DEFAULT_UI.hoverOpen,
    meanwhileMaxSpan:
      typeof u.meanwhileMaxSpan === 'number' && u.meanwhileMaxSpan >= 0
        ? Math.round(u.meanwhileMaxSpan)
        : DEFAULT_UI.meanwhileMaxSpan,
  };
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
        ui: raw.ui ? normalizeUi(raw.ui) : undefined,
      };
      this.mtime = mtime;
    } catch (e) {
      console.warn('[settings] unreadable file, keeping previous values:', (e as Error).message);
    }
  }
}
