import { createReadStream } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { ClientMessage, type ServerMessage } from '@way/shared';
import {
  createRouter, createStore, DoorService, enforceCacheLimit, ensureBorders, InlineBus, listSnapshots, loadConfig, loadPoiDetail, RedisBus, snapshotFor, type JobBus,
} from '@way/core';
import { ViewService, type View } from './views.ts';

const cfg = loadConfig();
const store = await createStore(cfg);
const router = createRouter(cfg);
const bus: JobBus = cfg.redisUrl ? new RedisBus(cfg.redisUrl) : new InlineBus(store, cfg, router);
const views = new ViewService(store, bus, cfg);
const doors = new DoorService(store);
const mode = {
  store: cfg.databaseUrl ? 'postgres' : cfg.dataDir ? 'embedded-postgres' : 'memory',
  queue: cfg.redisUrl ? 'redis' : 'inline',
};

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(websocket);

// Single-container mode: the API also serves the built front (SPA fallback).
if (cfg.staticDir) {
  await app.register(fastifyStatic, { root: cfg.staticDir });
  // Unknown app routes get the SPA; unknown files (a stale hashed bundle) and API paths get a 404.
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(path)) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

app.get('/api/health', async () => ({ ok: true, ...mode }));

const PoisQuery = z.object({
  res: z.coerce.number().int().min(0).max(8),
  cells: z.string().transform((s) => s.split(',').filter(Boolean).slice(0, 64)),
  tStart: z.coerce.number().int(),
  tEnd: z.coerce.number().int(),
  filter: z.string().default('all'),
});

// REST equivalent of the WebSocket "view" message (handy for debugging).
app.get('/api/pois', async (req, reply) => {
  const q = PoisQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.issues });
  const { pois, pending } = await views.resolve(q.data);
  return { pois, pendingKeys: [...pending] };
});

app.get<{ Params: { id: string }; Querystring: { prefetch?: string } }>('/api/poi/:id', async (req, reply) => {
  const prefetch = req.query.prefetch === '1';
  const poi = await loadPoiDetail(req.params.id, store, { touch: !prefetch, router });
  if (!poi) return reply.code(404).send({ error: 'not found' });
  // A card is being read: look for its doors meanwhile (brief §4.5).
  if (!prefetch) doors.warm(poi);
  return poi;
});

// Doors arrive progressively: `pending` lists kinds still being searched.
app.get<{ Params: { id: string } }>('/api/poi/:id/doors', async (req, reply) => {
  const res = await doors.get(req.params.id);
  if (!res) return reply.code(404).send({ error: 'not found' });
  return res;
});

app.get<{ Querystring: { year?: string } }>('/api/borders', async (req, reply) => {
  const snapshots = listSnapshots(cfg.bordersDir);
  if (req.query.year === undefined) return { years: snapshots.map((s) => s.year) };
  const snap = snapshotFor(snapshots, Number(req.query.year));
  if (!snap) return reply.code(404).send({ error: 'no border snapshots installed (npm run borders:fetch)' });
  return reply
    .header('Content-Type', 'application/geo+json')
    .header('Cache-Control', 'public, max-age=86400')
    .header('X-Snapshot-Year', String(snap.year))
    .send(createReadStream(snap.file));
});

app.get('/api/admin/providers', async () => ({
  mode,
  queue: await bus.stats(),
  keys: await store.keyStats(),
  pois: await store.poiCount(),
  cache: { bytes: await store.cacheBytes(), maxBytes: cfg.cache.maxBytes },
  level1: [
    { name: 'wikidata', status: 'active' },
    { name: 'wikipedia', status: 'active' },
  ],
  level2: {
    enabled: cfg.level2.enabled,
    // Degraded mode (§8.4): no LLM configured or every quota spent.
    mode: !cfg.level2.enabled ? 'off' : router.canRun('extract') ? 'active' : router.hasProvider('extract') ? 'degraded' : 'no-llm',
    providers: router.status(),
  },
}));

app.get('/ws', { websocket: true }, (socket) => {
  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const session = views.openSession(send);
  socket.on('message', async (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(raw.toString()));
    } catch {
      return; // ignore malformed messages
    }
    try {
      const { type: _t, ...view } = msg;
      await session.setView(view as View);
    } catch (e) {
      app.log.error(e, 'view resolution failed');
    }
  });
  socket.on('close', () => session.close());
});

const shutdown = async () => {
  await app.close();
  await bus.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });

// Border snapshots are fetched once, in the background, on first start.
if (cfg.dataDir && listSnapshots(cfg.bordersDir).length < 40) {
  ensureBorders(cfg.bordersDir, cfg.userAgent)
    .then((n) => app.log.info(`borders: ${n} snapshot(s) downloaded`))
    .catch((e) => app.log.warn(`borders download failed: ${(e as Error).message}`));
}
// Bounded cache: checked shortly after start, then hourly.
const checkCache = () =>
  enforceCacheLimit(store, cfg)
    .then(({ bytes, removed }) => {
      if (removed) app.log.info(`cache: evicted ${removed} POIs, now ${Math.round(bytes / 1048576)} MB`);
    })
    .catch((e) => app.log.warn(`cache check failed: ${(e as Error).message}`));
setTimeout(checkCache, 60_000).unref();
setInterval(checkCache, 3_600_000).unref();

app.log.info(`Way API ready (store=${mode.store}, queue=${mode.queue})`);
