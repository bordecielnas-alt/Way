import { createReadStream } from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { ClientMessage, type ServerMessage } from '@way/shared';
import {
  createStore, InlineBus, listSnapshots, loadConfig, loadPoiDetail, RedisBus, snapshotFor, type JobBus,
} from '@way/core';
import { ViewService, type View } from './views.ts';

const cfg = loadConfig();
const store = await createStore(cfg);
const bus: JobBus = cfg.redisUrl ? new RedisBus(cfg.redisUrl) : new InlineBus(store, cfg);
const views = new ViewService(store, bus, cfg);
const mode = { store: cfg.databaseUrl ? 'postgres' : 'memory', queue: cfg.redisUrl ? 'redis' : 'inline' };

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(websocket);

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

app.get<{ Params: { id: string } }>('/api/poi/:id', async (req, reply) => {
  const poi = await loadPoiDetail(req.params.id, store);
  if (!poi) return reply.code(404).send({ error: 'not found' });
  return poi;
});

// Doors (brief §4.5) arrive in V1.
app.get('/api/poi/:id/doors', async () => ({ doors: [], status: 'not_implemented' }));

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
  providers: [
    { name: 'wikidata', level: 1, status: 'active' },
    { name: 'wikipedia', level: 1, status: 'active' },
  ],
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
app.log.info(`Way API ready (store=${mode.store}, queue=${mode.queue})`);
