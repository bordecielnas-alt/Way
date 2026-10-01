import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { setUserAgent } from '@way/providers';
import type { Config } from './config.ts';
import { MemoryStore } from './store/memory.ts';
import { loadRouterConfig, ProviderRouter } from './router.ts';
import { PostgresStore } from './store/postgres.ts';
import { SettingsFile } from './settings.ts';
import { PolityService } from './polity.ts';
import { Cliopatria } from './cliopatria.ts';
import { BordersService } from './borders.ts';
import { PeopleService } from './people.ts';
import { SoundFiles } from './sounds.ts';
import { MediaCache } from './media.ts';
import { FlowService } from './flows.ts';
import { normalizeCache, refreshMs } from './settings.ts';
import type { Store } from './store/types.ts';

/** Local files in dev (no DATA_DIR): settings, account. */
export const devDir = fileURLToPath(new URL('../../../.dev/', import.meta.url));

export * from './config.ts';
export * from './pipeline.ts';
export * from './bus.ts';
export * from './detail.ts';
export * from './cache.ts';
export * from './router.ts';
export * from './level2.ts';
export * from './doors.ts';
export * from './links.ts';
export * from './flows.ts';
export * from './settings.ts';
export * from './polity.ts';
export * from './borders.ts';
export * from './cliopatria.ts';
export * from './people.ts';
export * from './sounds.ts';
export * from './media.ts';
export * from './store/types.ts';
export { MemoryStore } from './store/memory.ts';
export { PostgresStore, type Queryable } from './store/postgres.ts';

/**
 * Store selected by config: external Postgres (DATABASE_URL), embedded
 * Postgres on disk (DATA_DIR, single-container mode), or memory (dev).
 */
export async function createStore(cfg: Config): Promise<Store> {
  setUserAgent(cfg.userAgent);
  let store: Store;
  if (cfg.databaseUrl) store = new PostgresStore(new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 }));
  else if (cfg.dataDir) {
    mkdirSync(cfg.dataDir, { recursive: true });
    store = new PostgresStore(new PGlite(join(cfg.dataDir, 'pgdata')));
  } else store = new MemoryStore(cfg.memoryStoreFile ?? undefined);
  await store.init();
  return store;
}

/** Settings saved from the web app, next to the data (dev: .dev/). */
export function createSettings(cfg: Config): SettingsFile {
  return new SettingsFile(join(cfg.dataDir ?? devDir, 'settings.json'));
}

/** Level-2 provider router; daily quota counters are kept next to the data. */
export function createRouter(cfg: Config, settings = createSettings(cfg)): ProviderRouter {
  const usage = cfg.dataDir ? join(cfg.dataDir, 'provider-usage.json') : null;
  return new ProviderRouter(loadRouterConfig(), process.env, usage, () => settings.get(), cfg.level2.enabled);
}

/** Kingdom cards and French names on the map, cached next to the data. */
export function createPolities(cfg: Config, clio: Cliopatria | null = null, settings?: SettingsFile): PolityService {
  const refresh = () => refreshMs(normalizeCache(settings?.get().cache, cfg.cache.maxBytes));
  return new PolityService(join(cfg.dataDir ?? devDir, 'polities.json'), cfg.bordersDir, clio, refresh);
}

/** Yearly borders (Cliopatria), with the old snapshots before 3400 BCE. */
export function createBorders(cfg: Config): { clio: Cliopatria; borders: BordersService } {
  const clio = new Cliopatria(cfg.cliopatriaFile);
  return { clio, borders: new BordersService(clio, cfg.bordersDir) };
}

/** People followed on the map and armies, cached next to the data. */
export function createPeople(cfg: Config, settings?: SettingsFile): PeopleService {
  const refresh = () => refreshMs(normalizeCache(settings?.get().cache, cfg.cache.maxBytes));
  return new PeopleService(join(cfg.dataDir ?? devDir, 'people.json'), refresh);
}

/**
 * Images kept on the server. They get at most half of the cache budget set
 * in the Réglages page; the points get the rest.
 */
export function createMedia(cfg: Config, settings: SettingsFile): MediaCache {
  const c = () => normalizeCache(settings.get().cache, cfg.cache.maxBytes);
  return new MediaCache(join(cfg.dataDir ?? devDir, 'media'), () => (c().maxGb * 1024 ** 3) / 2, () => c().images);
}

/** Total disk budget for the cache, in bytes (Réglages page, else CACHE_MAX_MB). */
export function cacheBudget(cfg: Config, settings: SettingsFile): number {
  return normalizeCache(settings.get().cache, cfg.cache.maxBytes).maxGb * 1024 ** 3;
}

/** Sounds imported in the Réglages page, next to the data. */
export function createSoundFiles(cfg: Config): SoundFiles {
  return new SoundFiles(join(cfg.dataDir ?? devDir, 'sounds'));
}

/** Trade routes, epidemics and diffusions read by an AI, kept next to the data. */
export function createFlows(cfg: Config, router: ProviderRouter): FlowService {
  return new FlowService(join(cfg.dataDir ?? devDir, 'flows.json'), router);
}
