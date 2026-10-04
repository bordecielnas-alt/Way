import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { FLOWS, histToAstro, type Flow, type FlowDef, type FlowStage, type FlowsResponse, type FlowStatus } from '@way/shared';
import { geocode, wikipedia, type Place } from '@way/providers';
import type { ProviderRouter } from './router.ts';

// Flows of the Monde vivant layers (trade routes, epidemics, diffusions):
// an AI reads each flow's Wikipedia article for the places it reached and
// when. It only names them: every stage must quote the article, fall within
// the flow's time, and be found on the map by the geocoders. A flow is read
// once, one at a time in the background, then kept on disk.

/** Bump when the reading changes: flows are read again. */
const FLOWS_VERSION = 1;
const ARTICLE_CHARS = 24_000;
const MAX_STAGES = 30;
/** An empty reading is tried again after this (another article, another AI). */
const EMPTY_RETRY_MS = 7 * 86_400_000;
const FAILED_RETRY_MS = 30 * 60_000;

const Stage = z.object({
  place: z.string().trim().min(2).max(120),
  modern_place: z.string().trim().min(2).max(200),
  year: z.number().int(),
  from: z.string().trim().max(120).nullish(),
  note: z.string().trim().min(2).max(90),
  quote: z.string().trim().min(12).max(500),
});
export const ExtractedStages = z.object({ stages: z.array(Stage.nullable().catch(null)).max(60).catch([]) });
type Stage = z.infer<typeof Stage>;

const KIND_TEXT: Record<FlowDef['kind'], string> = {
  trade: 'a trade route: the cities, ports, oases and markets it linked, with the year the article says each was part of the route (or the route\'s own start when it gives none), and for each the previous place along the route',
  epidemic: 'an epidemic: the places it reached, with the year it reached each, and for each the place it came from',
  diffusion: 'a spread (of a people, a religion, a script or a technique): the places it reached, with the year it reached each, and for each the place it came from',
};

function system(def: FlowDef): string {
  return `You read a Wikipedia article about ${KIND_TEXT[def.kind]}.
Rules, all mandatory:
- Use ONLY places and dates the article states explicitly. Never add knowledge of your own. Fewer stages are better than doubtful ones.
- Only between ${def.start} and ${def.end} (historical years: negative before Christ, -44 = 44 BC, no year 0).
- place: the name used in the article.
- modern_place: the place as findable on a map today, followed by its country (e.g. "Kashgar, China", "Messina, Italy"). A city or a region, never coordinates.
- from: the "place" of the stage it came from, exactly as you wrote it in another stage, or null for a starting point.
- note: what happened there, in French, 2 to 8 words (e.g. "Arrivée de la peste", "Grand marché caravanier").
- quote: the exact words of the article (copied verbatim, 12 to 300 characters) stating it.
- At most ${MAX_STAGES} stages, in the order of time.
Answer with a single JSON object: {"stages": [...]}.`;
}

/** Lowercase, accents and punctuation removed, spaces collapsed. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Keeps the stages quoted in the article and within the flow's time
 * (a few years of slack), links each to the one it came from, and orders
 * them by time. Pure, for tests: places are given already located.
 */
export function buildStages(def: FlowDef, article: string, found: { stage: Stage; at: { lat: number; lon: number } | null }[]): FlowStage[] {
  const text = normalizeText(article);
  const slack = Math.max(3, Math.round((histToAstro(def.end) - histToAstro(def.start)) / 10));
  const fits = (y: number) => y !== 0 && histToAstro(y) >= histToAstro(def.start) - slack && histToAstro(y) <= histToAstro(def.end) + slack;
  const kept = found.filter(({ stage, at }) => {
    const q = normalizeText(stage.quote);
    return at && q.length >= 10 && text.includes(q.slice(0, 80)) && fits(stage.year);
  });
  // One stage per place: the earliest.
  const byPlace = new Map<string, (typeof kept)[number]>();
  for (const k of kept.sort((a, b) => a.stage.year - b.stage.year)) {
    const key = normalizeText(k.stage.place);
    if (!byPlace.has(key)) byPlace.set(key, k);
  }
  const list = [...byPlace.values()].slice(0, MAX_STAGES);
  const index = new Map(list.map((k, i) => [normalizeText(k.stage.place), i]));
  return list.map(({ stage, at }, i) => {
    const from = stage.from ? index.get(normalizeText(stage.from)) : undefined;
    return {
      place: stage.place,
      lat: Math.round(at!.lat * 1000) / 1000,
      lon: Math.round(at!.lon * 1000) / 1000,
      year: stage.year,
      // Only from an earlier stage (or one of the same year listed before it).
      from: from !== undefined && from < i ? from : null,
      note: stage.note.charAt(0).toUpperCase() + stage.note.slice(1),
    };
  });
}

interface Entry { at: number; v: number; flow: Flow | null }

export class FlowService {
  private cache: Record<string, Entry> = {};
  private queue: FlowDef[] = [];
  private reading: string | null = null;
  private failed = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;
  private places = new Map<string, Place | null>();

  constructor(private file: string | null, private router: ProviderRouter) {
    if (file && existsSync(file)) {
      try {
        this.cache = (JSON.parse(readFileSync(file, 'utf8')) as { flows?: Record<string, Entry> }).flows ?? {};
      } catch {
        /* corrupt cache: read again */
      }
    }
  }

  /** The flows asked for, as known now; those never read are queued. */
  get(ids: string[]): FlowsResponse {
    const flows = ids.flatMap((id) => {
      const def = FLOWS.find((f) => f.id === id);
      if (!def) return [];
      const hit = this.cache[id];
      const fresh = hit && hit.v === FLOWS_VERSION && (hit.flow || Date.now() - hit.at < EMPTY_RETRY_MS);
      if (fresh) return [{ id, status: (hit.flow ? 'ready' : 'empty') as FlowStatus, flow: hit.flow }];
      if (!this.router.canRun('extract')) {
        // An old reading is better than none.
        const status: FlowStatus = hit?.flow ? 'ready' : 'no-ai';
        return [{ id, status, flow: hit?.flow ?? null }];
      }
      this.enqueue(def);
      return [{ id, status: (hit?.flow ? 'ready' : 'pending') as FlowStatus, flow: hit?.flow ?? null }];
    });
    return { flows };
  }

  private enqueue(def: FlowDef): void {
    if (this.reading === def.id || this.queue.some((d) => d.id === def.id)) return;
    if ((this.failed.get(def.id) ?? 0) > Date.now()) return;
    this.queue.push(def);
    if (!this.reading) void this.pump();
  }

  /** One flow at a time: free AI quotas are small. */
  private async pump(): Promise<void> {
    const def = this.queue.shift();
    if (!def) return;
    this.reading = def.id;
    try {
      const flow = await this.read(def);
      this.cache[def.id] = { at: Date.now(), v: FLOWS_VERSION, flow };
      this.scheduleSave();
      console.log(`[flows] ${def.id}: ${flow ? `${flow.stages.length} stages` : 'nothing found'}`);
    } catch (e) {
      this.failed.set(def.id, Date.now() + FAILED_RETRY_MS);
      console.warn(`[flows] ${def.id} failed:`, (e as Error).message);
    } finally {
      this.reading = null;
      void this.pump();
    }
  }

  private async read(def: FlowDef): Promise<Flow | null> {
    for (const a of def.articles) {
      const article = await wikipedia.pageText(a.lang, a.title, ARTICLE_CHARS);
      if (!article) continue;
      const answer = await this.router.completeJson('extract', system(def), `Article « ${article.title} » :\n\n${article.text}`, (v) => ExtractedStages.parse(v));
      if (!answer) throw new Error('no AI available');
      const stages = answer.value.stages.filter((s): s is Stage => !!s);
      const found = [];
      for (const stage of stages) found.push({ stage, at: await this.locate(stage.modern_place) });
      const built = buildStages(def, article.text, found);
      if (built.length >= 2) {
        return {
          id: def.id,
          stages: built,
          source: { url: article.url, title: `Wikipédia : ${article.title}`, kind: 'wikipedia' },
          provider: answer.ai,
        };
      }
    }
    return null;
  }

  /**
   * A place name on the map: Nominatim first ("Messina, Italy" is what it
   * reads best), then Wikidata for the name alone. Remembered.
   */
  private async locate(name: string): Promise<Place | null> {
    const key = name.toLowerCase();
    if (this.places.has(key)) return this.places.get(key)!;
    const hit = (await geocode.nominatimSearch(name, undefined, 1).catch(() => []))[0]
      ?? (await geocode.wikidataPlaces(name.split(',')[0]!.trim(), 'en', 3).catch(() => []))[0]
      ?? null;
    this.places.set(key, hit);
    return hit;
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify({ flows: this.cache }));
      } catch (e) {
        console.warn('[flows] could not save cache:', (e as Error).message);
      }
    }, 2000);
    this.saveTimer.unref();
  }
}
