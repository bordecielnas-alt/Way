import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { ClientMessage, THEMES, type ScenarioContext, type ServerMessage } from '@way/shared';
import {
  cacheBudget, createMedia, normalizeCache, CACHE_MAX_GB, createBorders, createFlows, createPeople, createStories, createPolities, createSoundFiles, SOUND_MAX_BYTES, SOUND_TYPES, createRouter, SNAPSHOTS_BEFORE, createSettings, createStore, devDir, normalizeUi, DoorService, enforceCacheLimit, findCards, ensureBorders, InlineBus, listSnapshots, loadConfig, loadPoiDetail, RedisBus, type JobBus,
} from '@way/core';
import { Auth, COOKIE, readCookie } from './auth.ts';
import { ViewService, type View } from './views.ts';

const cfg = loadConfig();
const store = await createStore(cfg);
const settings = createSettings(cfg);
const router = createRouter(cfg, settings);
const auth = new Auth(join(cfg.dataDir ?? devDir, 'auth.json'));
const bus: JobBus = cfg.redisUrl ? new RedisBus(cfg.redisUrl) : new InlineBus(store, cfg, router);
const views = new ViewService(store, bus, cfg, () => router.hasProvider('extract'));
const doors = new DoorService(store, () => normalizeUi(settings.get().ui).meanwhileMaxSpan, router);
const { clio, borders } = createBorders(cfg);
const polities = createPolities(cfg, clio, settings);
// Names, coats of arms and faiths of every realm, completed little by little in the background.
polities.startRefining();
const people = createPeople(cfg, settings);
const flows = createFlows(cfg, router);
const stories = createStories(cfg, store, router);
const media = createMedia(cfg, settings);
const soundFiles = createSoundFiles(cfg);
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

// ---------- account and settings (Réglages page) ----------

const PROTECTED = ['/api/admin', '/api/settings', '/api/auth/password'];
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0]!;
  if (!path.startsWith('/api/')) return;
  // Writes must come from this site (the cookie is SameSite=Strict too).
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && URL.parse(origin)?.host !== req.headers.host) {
    return reply.code(403).send({ error: 'origine refusée' });
  }
  if (PROTECTED.some((p) => path.startsWith(p)) && !auth.verify(readCookie(req, COOKIE))) {
    return reply.code(401).send({ error: 'connexion requise' });
  }
});

app.get('/api/auth/me', async (req, reply) => {
  const user = auth.verify(readCookie(req, COOKIE));
  if (!user) return reply.code(401).send({ error: 'connexion requise' });
  return { user, defaultPassword: auth.usesDefaultPassword };
});

const Login = z.object({ username: z.string().max(100), password: z.string().max(200) });
app.post('/api/auth/login', async (req, reply) => {
  const body = Login.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'requête invalide' });
  const wait = auth.locked(req.ip);
  if (wait) return reply.code(429).send({ error: `Trop d'essais : réessayez dans ${Math.ceil(wait / 60000)} min.` });
  const token = auth.login(req.ip, body.data.username, body.data.password);
  if (!token) {
    await new Promise((r) => setTimeout(r, 800)); // slows down guessing
    return reply.code(401).send({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  auth.setCookie(reply, req, token);
  return { user: body.data.username.trim().toLowerCase(), defaultPassword: auth.usesDefaultPassword };
});

app.post('/api/auth/logout', async (req, reply) => {
  auth.setCookie(reply, req, null);
  return { ok: true };
});

const Password = z.object({ current: z.string().max(200), next: z.string().min(6).max(200) });
app.post('/api/auth/password', async (req, reply) => {
  const body = Password.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères.' });
  const token = auth.changePassword(body.data.current, body.data.next);
  if (!token) return reply.code(403).send({ error: 'Mot de passe actuel incorrect.' });
  auth.setCookie(reply, req, token);
  return { ok: true };
});

/** Keys are never sent back whole: only their last characters. */
const isSecret = (name: string) => /(_KEY|_TOKEN)$/.test(name);
const mask = (v: string) => (v.length > 8 ? `…${v.slice(-4)}` : '…');

function settingsView() {
  const saved = settings.get();
  const variables = Object.fromEntries(
    router.variables().map((name) => {
      const source = router.source(name);
      const value = source === 'settings' ? saved.env[name]! : source === 'env' ? process.env[name]! : null;
      return [name, { source, value: value === null ? null : isSecret(name) ? mask(value) : value, secret: isSecret(name) }];
    }),
  );
  return {
    level2: { enabled: router.enabled, source: saved.level2 === undefined ? 'env' : 'settings' },
    variables,
    providers: router.status(),
    ui: normalizeUi(saved.ui),
    cache: normalizeCache(saved.cache, cfg.cache.maxBytes),
  };
}

app.get('/api/settings', async () => settingsView());

const SettingsBody = z.object({
  level2: z.boolean().nullable().optional(),
  env: z.record(z.string(), z.string().max(500).nullable()).optional(),
  disabled: z.array(z.string()).optional(),
  ui: z.object({
    sounds: z.boolean(),
    volume: z.number().min(0).max(1),
    hoverOpen: z.boolean(),
    meanwhileMaxSpan: z.number().int().min(0).max(10000),
  }).partial().optional(),
  cache: z.object({
    maxGb: z.number().min(0.5).max(CACHE_MAX_GB),
    refreshDays: z.number().int().min(0).max(3650),
    images: z.boolean(),
  }).partial().optional(),
});
app.put('/api/settings', async (req, reply) => {
  const body = SettingsBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'requête invalide' });
  const allowed = new Set(router.variables());
  const ids = new Set(router.status().map((p) => p.id));
  const cur = settings.get();
  const ui = body.data.ui ? normalizeUi({ ...normalizeUi(cur.ui), ...body.data.ui }) : cur.ui;
  const cache = body.data.cache ? normalizeCache({ ...normalizeCache(cur.cache, cfg.cache.maxBytes), ...body.data.cache }, cfg.cache.maxBytes) : cur.cache;
  const next = { level2: cur.level2, env: { ...cur.env }, disabled: [...cur.disabled], ui, cache };
  if (body.data.level2 !== undefined) next.level2 = body.data.level2 ?? undefined;
  for (const [name, value] of Object.entries(body.data.env ?? {})) {
    if (!allowed.has(name)) return reply.code(400).send({ error: `variable inconnue : ${name}` });
    const v = value?.trim();
    if (v) next.env[name] = v;
    else delete next.env[name];
  }
  if (body.data.disabled) next.disabled = body.data.disabled.filter((id) => ids.has(id));
  settings.save(next);
  // A smaller budget applies at once.
  if (body.data.cache) {
    media.evict();
    void checkCache();
  }
  req.log.info({ level2: next.level2, vars: Object.keys(next.env), disabled: next.disabled }, 'settings saved');
  return settingsView();
});

app.post('/api/settings/test', async (req, reply) => {
  const body = z.object({ id: z.string() }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'requête invalide' });
  return router.test(body.data.id);
});

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

// The card's story (places, people): its bones read from the article in seconds (`pending` meanwhile), an AI labelling them (`draft`).
app.get<{ Params: { id: string } }>('/api/poi/:id/story', async (req, reply) => {
  const poi = await store.getPoi(req.params.id);
  if (!poi) return reply.code(404).send({ error: 'not found' });
  return stories.get(poi);
});

// Scenarios over that story, written for the visitor's lens, themes and walk so far.
const ScenariosQuery = z.object({
  lens: z.string().max(40).optional(),
  themes: z.string().max(300).default(''),
  people: z.enum(['0', '1']).default('1'),
  trail: z.union([z.string().max(300), z.array(z.string().max(300)).max(12)]).optional(),
});
function scenarioContext(q: z.infer<typeof ScenariosQuery>): ScenarioContext {
  const trail = q.trail === undefined ? [] : Array.isArray(q.trail) ? q.trail : [q.trail];
  return {
    lens: q.lens || null,
    themes: THEMES.filter((t) => q.themes.split(',').includes(t)),
    people: q.people === '1',
    trail: trail.slice(-6),
  };
}
app.get<{ Params: { id: string } }>('/api/poi/:id/scenarios', async (req, reply) => {
  const q = ScenariosQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.issues });
  const poi = await store.getPoi(req.params.id);
  if (!poi) return reply.code(404).send({ error: 'not found' });
  return stories.scenarios(poi, scenarioContext(q.data));
});

// The search bar: cards (events, places, works) by name; people have their own search.
app.get('/api/search', async (req, reply) => {
  const q = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  try {
    return { pois: await findCards(q.data.q, store) };
  } catch (e) {
    req.log.warn(`card search failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

// Kingdom card: the territory's name in the snapshot and the timeline year.
// A region picked inside a territory is asked by its Wikidata item instead.
const Year = z.coerce.number().int().min(-10000).max(2100);
const Qid = z.string().regex(/^Q\d{1,12}$/);
const PolityQuery = z.union([
  z.object({ qid: Qid, year: Year, name: z.string().min(1).max(200).optional() }),
  z.object({ name: z.string().min(1).max(200), year: Year }),
]);
app.get('/api/polity', async (req, reply) => {
  const q = PolityQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  return 'qid' in q.data ? polities.infoById(q.data.qid, q.data.year, q.data.name) : polities.info(q.data.name!, q.data.year);
});

// Regions of a territory (duchies, provinces, counties) at a year, placed at their seats.
app.get('/api/polity/subdivisions', async (req, reply) => {
  const q = z.object({ qid: Qid, year: Year }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  try {
    return await polities.subdivisions(q.data.qid, q.data.year);
  } catch (e) {
    req.log.warn(`subdivisions of ${q.data.qid} failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

// French names for the territories of the snapshot shown at `year`.
app.get<{ Querystring: { year?: string } }>('/api/polity/labels', async (req, reply) => {
  const year = Number(req.query.year);
  if (!Number.isFinite(year)) return reply.code(400).send({ error: 'année manquante' });
  return polities.labels(year);
});

// Coats of arms and flags of the realms shown at a year (watermarks on the map).
app.get<{ Querystring: { year?: string } }>('/api/polity/emblems', async (req, reply) => {
  const year = Number(req.query.year);
  if (!Number.isFinite(year)) return reply.code(400).send({ error: 'année manquante' });
  return polities.emblems(year);
});

// Religions of the realms shown at a year (the religious backdrop).
app.get<{ Querystring: { year?: string } }>('/api/polity/faiths', async (req, reply) => {
  const year = Number(req.query.year);
  if (!Number.isFinite(year)) return reply.code(400).send({ error: 'année manquante' });
  return polities.faiths(year);
});

// Coats of arms and flags of given items (the sides of the armies shown).
app.get('/api/emblems', async (req, reply) => {
  const q = z.object({
    qids: z.string().transform((s) => s.split(',').filter((x) => Qid.safeParse(x).success).slice(0, 100)),
    year: Year,
  }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  return polities.emblemsOf(q.data.qids, q.data.year);
});

// Wikimedia images through the server: asked once, then served from disk
// (and same-origin, so the map can paint coats of arms).
app.get<{ Querystring: { f?: string; w?: string; u?: string } }>('/api/media', async (req, reply) => {
  const { f, w, u } = req.query;
  const want = f ? { file: f, width: Number(w) || 256 } : u ? { url: u } : null;
  if (!want) return reply.code(400).send({ error: 'requête invalide' });
  try {
    const got = await media.get(want);
    if (!got) return reply.code(400).send({ error: 'image non prise en charge' });
    return reply.header('Content-Type', got.type).header('Cache-Control', 'public, max-age=2592000')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").send(got.data);
  } catch (e) {
    req.log.warn(`media ${f ?? u} failed: ${(e as Error).message}`);
    return reply.code(502).send({ error: 'image indisponible' });
  }
});

// Land cover tiles for the Géographie layer, kept with the images.
app.get<{ Params: { z: string; x: string; y: string } }>('/api/geo/landcover/:z/:x/:y', async (req, reply) => {
  const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => Number(v.replace(/\.png$/, '')));
  try {
    const got = await media.get({ tile: 'landcover', z: z!, x: x!, y: y! });
    if (!got) return reply.code(400).send({ error: 'tuile invalide' });
    return reply.header('Content-Type', got.type).header('Cache-Control', 'public, max-age=2592000').send(got.data);
  } catch (e) {
    req.log.warn(`landcover ${z}/${x}/${y} failed: ${(e as Error).message}`);
    return reply.code(502).send({ error: 'tuile indisponible' });
  }
});

app.delete('/api/admin/media', async () => {
  media.clear();
  return { bytes: media.bytes, count: media.count };
});

// ---------- people followed on the map, armies ----------

app.get('/api/people/search', async (req, reply) => {
  const q = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  try {
    return await people.search(q.data.q);
  } catch (e) {
    req.log.warn(`people search failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

app.get<{ Params: { qid: string } }>('/api/people/:qid', async (req, reply) => {
  if (!Qid.safeParse(req.params.qid).success) return reply.code(400).send({ error: 'requête invalide' });
  try {
    const j = await people.journey(req.params.qid);
    if (!j) return reply.code(404).send({ error: 'personne inconnue' });
    return j;
  } catch (e) {
    req.log.warn(`journey of ${req.params.qid} failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

// A real person's life as a scenario, across the cards they appear in, for the visitor's view.
app.get<{ Params: { qid: string } }>('/api/people/:qid/scenario', async (req, reply) => {
  if (!Qid.safeParse(req.params.qid).success) return reply.code(400).send({ error: 'requête invalide' });
  const q = ScenariosQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.issues });
  try {
    const j = await people.journey(req.params.qid);
    if (!j) return reply.code(404).send({ error: 'personne inconnue' });
    return await stories.personScenario(j, scenarioContext(q.data));
  } catch (e) {
    req.log.warn(`life scenario of ${req.params.qid} failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

// A short detour off the scenario played: around a person, or at a place's card, near the year branched from.
const DetourQuery = ScenariosQuery.extend({
  kind: z.enum(['person', 'card']),
  id: z.string().min(1).max(200),
  year: z.coerce.number().int().min(-10_000).max(3000),
  from: z.string().trim().min(1).max(120),
  /** The card of the scenario branched from. */
  card: z.string().max(200).optional(),
});
app.get('/api/detour', async (req, reply) => {
  const q = DetourQuery.safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.issues });
  const { kind, id, year, from } = q.data;
  try {
    if (kind === 'person') {
      if (!Qid.safeParse(id).success) return reply.code(400).send({ error: 'requête invalide' });
      const j = await people.journey(id);
      if (!j) return reply.code(404).send({ error: 'personne inconnue' });
      const card = q.data.card ? await store.getPoi(q.data.card) : null;
      return await stories.detour({ kind, journey: j }, year, from, scenarioContext(q.data), card?.wikidata_qid ?? null);
    }
    const poi = await store.getPoi(id);
    if (!poi) return reply.code(404).send({ error: 'not found' });
    return await stories.detour({ kind, poi }, year, from, scenarioContext(q.data));
  } catch (e) {
    req.log.warn(`detour ${kind} ${id} failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

// Armies of the wars fought during a decade (first year, a multiple of 10).
app.get('/api/armies', async (req, reply) => {
  const q = z.object({ decade: z.coerce.number().int().min(-3000).max(2030).refine((d) => d % 10 === 0) }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  try {
    return await people.armies(q.data.decade);
  } catch (e) {
    req.log.warn(`armies of ${q.data.decade}s failed: ${(e as Error).message}`);
    return reply.code(503).send({ error: 'Wikidata ne répond pas pour le moment.' });
  }
});

// ---------- Monde vivant: trade routes, epidemics, diffusions ----------

// Flows asked by id (the front knows the catalog and the period shown); those never read are read in the background.
app.get('/api/flows', async (req, reply) => {
  const q = z.object({ ids: z.string().transform((s) => s.split(',').filter(Boolean).slice(0, 60)) }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'requête invalide' });
  return flows.get(q.data.ids);
});

// ---------- sounds imported by the owner (they replace the synthesized ones) ----------

app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: SOUND_MAX_BYTES + 1024 }, (_req, body, done) => done(null, body));
const SoundKind = z.string().regex(/^[a-z]{3,20}$/);

app.get('/api/sounds', async (_req, reply) => reply.header('Cache-Control', 'no-cache').send(soundFiles.list()));

app.get<{ Params: { kind: string } }>('/api/sounds/:kind', async (req, reply) => {
  const f = SoundKind.safeParse(req.params.kind).success ? soundFiles.read(req.params.kind) : null;
  if (!f) return reply.code(404).send({ error: 'aucun son importé' });
  // The URL carries the version: a new import gets a new URL.
  return reply.header('Content-Type', f.type).header('Cache-Control', 'public, max-age=31536000, immutable').send(f.data);
});

app.put<{ Params: { kind: string } }>('/api/admin/sounds/:kind', async (req, reply) => {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!SoundKind.safeParse(req.params.kind).success || !SOUND_TYPES[type] || !Buffer.isBuffer(req.body)) {
    return reply.code(400).send({ error: 'Format non pris en charge : mp3, ogg, wav, m4a, aac, flac ou webm.' });
  }
  try {
    soundFiles.save(req.params.kind, type, req.body);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  return soundFiles.list();
});

app.delete<{ Params: { kind: string } }>('/api/admin/sounds/:kind', async (req, reply) => {
  if (!SoundKind.safeParse(req.params.kind).success) return reply.code(400).send({ error: 'requête invalide' });
  soundFiles.remove(req.params.kind);
  return soundFiles.list();
});

// Interface preferences shared by every viewer (set in the Réglages page).
app.get('/api/ui', async () => normalizeUi(settings.get().ui));

// Years where borders change; the front asks for a period by its first year.
app.get('/api/borders/index', async (_req, reply) => {
  const index = borders.index();
  if (!index) return reply.code(404).send({ error: 'no borders installed (npm run borders:fetch)' });
  return reply.header('Cache-Control', 'no-cache').send(index);
});

// Borders of the period containing `year`. With the dataset version in `v`,
// the answer never changes: the browser keeps it.
app.get<{ Querystring: { year?: string; v?: string } }>('/api/borders', async (req, reply) => {
  const year = Number(req.query.year);
  if (!Number.isFinite(year)) return reply.code(400).send({ error: 'année manquante' });
  const period = borders.period(year);
  if (!period) return reply.code(404).send({ error: 'no borders for that year' });
  const pinned = req.query.v && req.query.v === borders.index()?.version;
  return reply.header('Cache-Control', pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600').send(period);
});

app.get('/api/admin/providers', async () => ({
  mode,
  queue: await bus.stats(),
  keys: await store.keyStats(),
  pois: await store.poiCount(),
  realms: polities.refineStats(),
  cache: {
    bytes: await store.cacheBytes(),
    maxBytes: cacheBudget(cfg, settings),
    media: { bytes: media.bytes, count: media.count },
  },
  level1: [
    { name: 'wikidata', status: 'active' },
    { name: 'wikipedia', status: 'active' },
  ],
  level2: {
    enabled: router.enabled,
    // Degraded mode (§8.4): no LLM configured or every quota spent.
    mode: !router.enabled ? 'off' : router.canRun('extract') ? 'active' : router.hasProvider('extract') ? 'degraded' : 'no-llm',
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
      if (msg.type === 'prefetch') {
        const { type: _t, ring, ...view } = msg;
        await session.prefetch(view as View, ring);
      } else {
        const { type: _t, ...view } = msg;
        await session.setView(view as View);
      }
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

// Border snapshots (before 3400 BCE only: Cliopatria covers the rest) are fetched once, in the background.
if (cfg.dataDir && !listSnapshots(cfg.bordersDir).some((s) => s.year < SNAPSHOTS_BEFORE)) {
  ensureBorders(cfg.bordersDir, cfg.userAgent)
    .then((n) => app.log.info(`borders: ${n} snapshot(s) downloaded`))
    .catch((e) => app.log.warn(`borders download failed: ${(e as Error).message}`));
}
// Bounded cache: checked shortly after start, then hourly.
// Points get the budget left by the images.
function checkCache(): Promise<void> {
  return enforceCacheLimit(store, cfg, Math.max(256 * 1024 ** 2, cacheBudget(cfg, settings) - media.bytes))
    .then(({ bytes, removed }) => {
      if (removed) app.log.info(`cache: evicted ${removed} POIs, now ${Math.round(bytes / 1048576)} MB`);
    })
    .catch((e) => app.log.warn(`cache check failed: ${(e as Error).message}`));
}
setTimeout(checkCache, 60_000).unref();
setInterval(checkCache, 3_600_000).unref();

if (!clio.available) app.log.warn('yearly borders missing: run npm run borders:fetch');
app.log.info(`Orbis API ready (store=${mode.store}, queue=${mode.queue})`);
