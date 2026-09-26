import { createRouter, createStore, loadConfig, startRedisWorker } from '@way/core';

const cfg = loadConfig();
if (!cfg.redisUrl) {
  console.error('[worker] REDIS_URL is required (without Redis, the API runs searches inline).');
  process.exit(1);
}

const store = await createStore(cfg);
const worker = startRedisWorker(cfg.redisUrl, store, cfg, createRouter(cfg));
console.log(`[worker] ready (concurrency=${cfg.workerConcurrency})`);

const shutdown = async () => {
  await worker.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
