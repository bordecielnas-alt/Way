import { afterEach, describe, expect, it, vi } from 'vitest';
import { latLngToCell } from 'h3-js';
import { runDeepJob, titleSimilarity } from './level2.ts';
import { ProviderRouter, type RouterConfig } from './router.ts';
import { MemoryStore } from './store/memory.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const config = (): RouterConfig => ({
  providers: {
    a: { type: 'llm', baseUrl: 'https://a.test/v1', keyEnv: 'A_KEY', model: 'm-a', perMinute: 2, perDay: 100 },
    b: { type: 'llm', baseUrl: 'https://b.test/v1', keyEnv: 'B_KEY', model: 'm-b', perMinute: 10, perDay: 100 },
    nokey: { type: 'llm', baseUrl: 'https://c.test/v1', keyEnv: 'C_KEY', model: 'm-c', perMinute: 10, perDay: 100 },
  },
  routes: { search: [], extract: ['nokey', 'a', 'b'], write: ['b'] },
  breaker: { failures: 2, cooldownMinutes: 10 },
  headroom: 1,
});

const completion = (content: string) => json({ choices: [{ message: { content } }] });

describe('provider router', () => {
  it('skips unconfigured providers, falls back on errors and opens the breaker on 429', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url).host);
      return url.startsWith('https://a.test') ? json({ error: 'quota' }, 429) : completion('{"ok": true}');
    }));
    const r = new ProviderRouter(config(), { A_KEY: 'x', B_KEY: 'y' });
    const first = await r.completeJson('extract', 's', 'u', (v) => v as { ok: boolean });
    expect(first).toEqual({ value: { ok: true }, provider: 'b' });
    expect(calls).toEqual(['a.test', 'b.test']);
    // "a" is now cooling down: straight to "b".
    await r.completeJson('extract', 's', 'u', (v) => v);
    expect(calls).toEqual(['a.test', 'b.test', 'b.test']);
    expect(r.status().find((p) => p.id === 'a')?.breakerOpenUntil).toBeGreaterThan(Date.now());
  });

  it('rejects answers the parser refuses and switches before the quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion('not json')));
    const r = new ProviderRouter(config(), { A_KEY: 'x' });
    expect(await r.completeJson('extract', 's', 'u', (v) => v)).toBeNull();
    // Two calls per minute allowed for "a": the third is refused locally.
    await r.completeJson('extract', 's', 'u', (v) => v);
    expect(r.canRun('extract')).toBe(false);
    expect(r.hasProvider('extract')).toBe(true);
  });

  it('is degraded without any key', () => {
    const r = new ProviderRouter(config(), {});
    expect(r.hasProvider('extract')).toBe(false);
  });
});

describe('level 2', () => {
  it('scores title similarity', () => {
    expect(titleSimilarity('Fondation d’Arles', 'Fondation de la ville d’Arles')).toBe(1);
    expect(titleSimilarity('Siège de Marseille', 'Bataille de Lyon')).toBe(0);
  });

  it('keeps only cited, dated, located and new facts', async () => {
    // Arles area; level-1 knows one fact already.
    const area = latLngToCell(43.68, 4.63, 4);
    const store = new MemoryStore();
    await store.init();

    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/reverse') return json({ address: { town: 'Arles', country: 'France' } });
      if (url.searchParams.get('action') === 'wbsearchentities') {
        const q = url.searchParams.get('search')!;
        return json({ search: q.startsWith('Arles') ? [{ id: 'Q48292', label: 'Arles' }] : q.startsWith('Lyon') ? [{ id: 'Q456', label: 'Lyon' }] : [] });
      }
      if (url.searchParams.get('action') === 'wbgetentities') {
        const claim = (lat: number, lon: number) => ({ claims: { P625: [{ mainsnak: { datavalue: { value: { latitude: lat, longitude: lon } } } }] } });
        return json({ entities: { Q48292: claim(43.677, 4.631), Q456: claim(45.76, 4.84) } });
      }
      if (url.pathname === '/search') return json([]); // Nominatim finds nothing else
      throw new Error(`unexpected ${input}`);
    }));

    const event = (over: Record<string, unknown>) => ({
      title: 'Construction de l’amphithéâtre',
      summary: 'Les Romains construisent un amphithéâtre à Arles pour accueillir environ vingt mille spectateurs lors des jeux.',
      category: 'monument',
      place_name: 'Arles, France',
      year_start: 90,
      date_precision: 'decade',
      sources: [1],
      importance: 0.9,
      ...over,
    });
    const router = {
      search: async () => [
        { title: 'Arles antique', url: 'https://fr.wikipedia.org/wiki/Arles_antique', text: '…' },
        { title: 'Blog', url: 'https://example.org/arles', text: '…' },
      ],
      completeJson: async (_t: string, _s: string, _u: string, parse: (v: unknown) => unknown) => ({
        provider: 'fake',
        value: parse({
          events: [
            event({}),
            event({ title: 'Doublon de l’amphithéâtre', summary: 'x'.repeat(50), sources: [2] }), // same place/time, similar title
            event({ title: 'Fait sans source', sources: [7] }),
            event({ title: 'Fait hors période', year_start: 1500 }),
            event({ title: 'Fait trop loin', place_name: 'Lyon, France' }),
            event({ title: 'Cirque romain d’Arles', category: 'nope', sources: [2], sources_disagree: false }),
          ],
        }),
      }),
    } as unknown as ProviderRouter;

    const r = await runDeepJob({ kind: 'deep', area, cells: [area], buckets: [50], filter: 'all' }, store, router);
    expect(r.found).toBe(2);
    const pois = await store.queryTimeRange(0, 200, 10);
    const byTitle = new Map(pois.map((p) => [p.title, p]));
    expect([...byTitle.keys()].sort()).toEqual(['Cirque romain d’Arles', 'Construction de l’amphithéâtre']);
    const amphi = (await store.getPoi(byTitle.get('Construction de l’amphithéâtre')!.id))!;
    expect(amphi.provenance).toBe('web_ai');
    expect(amphi.confidence).toBe('verified'); // cites Wikipedia
    expect(amphi.importance).toBeLessThanOrEqual(0.35); // LLM estimate is capped
    expect(amphi.summary_lang).toBe('fr');
    const cirque = (await store.getPoi(byTitle.get('Cirque romain d’Arles')!.id))!;
    expect(cirque.confidence).toBe('web_single_source');
    expect(cirque.category).toBe('event'); // unknown category falls back
  });
});
