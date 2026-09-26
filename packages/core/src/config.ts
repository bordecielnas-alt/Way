import { fileURLToPath } from 'node:url';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export interface Config {
  port: number;
  host: string;
  databaseUrl: string | null;
  redisUrl: string | null;
  memoryStoreFile: string | null;
  bordersDir: string;
  userAgent: string;
  workerConcurrency: number;
  search: {
    globalMinSitelinks: number;
    globalLimit: number;
    /** Max span (years) covered by a single global query. */
    globalMaxSpan: number;
    cellLimit: number;
    /** A pending key older than this is considered abandoned. */
    pendingTimeoutMs: number;
    /** Failed keys are retried after this delay. */
    failedRetryMs: number;
  };
}

export function loadConfig(env = process.env): Config {
  const contact = env.WAY_CONTACT?.trim();
  return {
    port: num(env.API_PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || null,
    redisUrl: env.REDIS_URL || null,
    // Dev without Postgres: the in-memory cache is snapshotted here (empty string disables).
    memoryStoreFile: env.MEMORY_STORE_FILE ?? fileURLToPath(new URL('../../../.dev/store.json', import.meta.url)),
    bordersDir: env.BORDERS_DIR ?? fileURLToPath(new URL('../../../data/borders/', import.meta.url)),
    // Wikimedia asks for a contact in the User-Agent: set WAY_CONTACT.
    userAgent: `Way/0.1 (personal history globe${contact ? `; ${contact}` : ''})`,
    workerConcurrency: num(env.WORKER_CONCURRENCY, 2),
    search: {
      globalMinSitelinks: num(env.GLOBAL_MIN_SITELINKS, 5),
      globalLimit: num(env.GLOBAL_LIMIT, 1200),
      globalMaxSpan: num(env.GLOBAL_MAX_SPAN, 10),
      cellLimit: num(env.CELL_LIMIT, 600),
      pendingTimeoutMs: num(env.PENDING_TIMEOUT_MS, 10 * 60_000),
      failedRetryMs: num(env.FAILED_RETRY_MS, 10 * 60_000),
    },
  };
}
