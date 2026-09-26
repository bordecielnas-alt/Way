import pg from 'pg';
import { setUserAgent } from '@way/providers';
import type { Config } from './config.ts';
import { MemoryStore } from './store/memory.ts';
import { PostgresStore } from './store/postgres.ts';
import type { Store } from './store/types.ts';

export * from './config.ts';
export * from './pipeline.ts';
export * from './bus.ts';
export * from './detail.ts';
export * from './borders.ts';
export * from './store/types.ts';
export { MemoryStore } from './store/memory.ts';
export { PostgresStore, type Queryable } from './store/postgres.ts';

/** Store selected by config: Postgres when DATABASE_URL is set, memory otherwise. */
export async function createStore(cfg: Config): Promise<Store> {
  setUserAgent(cfg.userAgent);
  const store = cfg.databaseUrl
    ? new PostgresStore(new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 }))
    : new MemoryStore(cfg.memoryStoreFile ?? undefined);
  await store.init();
  return store;
}
