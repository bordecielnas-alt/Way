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
  /** How much is kept on disk, and for how long before checking again. */
  cache?: CacheSettings;
}

export interface CacheSettings {
  /** Disk budget for everything cached (points, images), in GB (0.5 to 100). */
  maxGb: number;
  /** Cards, names, journeys and armies are checked again after this many days (0 = never). */
  refreshDays: number;
  /** Images (portraits, coats of arms, photos) are kept on the server instead of asked from Wikimedia each time. */
  images: boolean;
}

export const CACHE_MAX_GB = 100;

/** Defaults: the budget from CACHE_MAX_MB (10 GB when unset). */
export function normalizeCache(raw: Partial<CacheSettings> | undefined, envMaxBytes: number): CacheSettings {
  const c: Partial<CacheSettings> = raw && typeof raw === 'object' ? raw : {};
  const gb = typeof c.maxGb === 'number' && Number.isFinite(c.maxGb) ? c.maxGb : envMaxBytes / 1024 ** 3;
  return {
    maxGb: Math.round(Math.min(CACHE_MAX_GB, Math.max(0.5, gb)) * 10) / 10,
    refreshDays: typeof c.refreshDays === 'number' && c.refreshDays >= 0 ? Math.min(3650, Math.round(c.refreshDays)) : 180,
    images: typeof c.images === 'boolean' ? c.images : true,
  };
}

/** Age past which a cached answer is fetched again (Infinity: never). */
export function refreshMs(c: CacheSettings): number {
  return c.refreshDays > 0 ? c.refreshDays * 86_400_000 : Infinity;
}

export interface UiSettings {
  sounds: boolean;
  volume: number;
  /** Resting the pointer on a point opens its card. */
  hoverOpen: boolean;
  /** "Pendant ce temps" skips events spanning more years than this. */
  meanwhileMaxSpan: number;
}

export const DEFAULT_UI: UiSettings = { sounds: true, volume: 0.6, hoverOpen: false, meanwhileMaxSpan: 1 };

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
        cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : undefined,
      };
      this.mtime = mtime;
    } catch (e) {
      console.warn('[settings] unreadable file, keeping previous values:', (e as Error).message);
    }
  }
}
