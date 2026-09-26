import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { setUserAgent } from '@way/providers';
import type { Config } from './config.ts';
import { MemoryStore } from './store/memory.ts';
import { loadRouterConfig, ProviderRouter } from './router.ts';
import { PostgresStore } from './store/postgres.ts';
import type { Store } from './store/types.ts';

export * from './config.ts';
export * from './pipeline.ts';
export * from './bus.ts';
export * from './detail.ts';
export * from './cache.ts';
export * from './router.ts';
export * from './level2.ts';
export * from './doors.ts';
export * from './borders.ts';
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

/** Level-2 provider router; daily quota counters are kept next to the data. */
export function createRouter(cfg: Config): ProviderRouter {
  const usage = cfg.dataDir ? join(cfg.dataDir, 'provider-usage.json') : null;
  return new ProviderRouter(loadRouterConfig(), process.env, usage);
}
