import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  background, coolingUntil, interactive, polity, wikipedia, type PolityCandidate, type PolityDetails, type SubdivisionRow,
} from '@way/providers';
import type { PolityInfo, PolityLabels, PolityRulerInfo, SubdivisionItem, SubdivisionsResponse } from '@way/shared';
import { listSnapshots, snapshotFor } from './borders.ts';

// Kingdoms and empires clicked on the map (and their names on it). The
// border snapshots only give an English name: it is matched to a Wikidata
// item by scoring candidates on type, dates and fame. Results are cached
// on disk; nothing is stored in the POI cache.

const STATE = new Set(['Q3024240', 'Q7275', 'Q3624078', 'Q6256', 'Q48349', 'Q417175', 'Q133442', 'Q1250464']);
const HISTORICAL_COUNTRY = 'Q3024240';
const PEOPLE = new Set(['Q41710', 'Q465299', 'Q133311']);
const CITY = new Set(['Q515', 'Q5119', 'Q1549591', 'Q200250', 'Q1637706', 'Q15284', 'Q484170', 'Q747074', 'Q3957']);
/** Disambiguation pages, lists, names: never a territory. */
const JUNK = new Set(['Q4167410', 'Q13406463', 'Q202444', 'Q101352', 'Q12308941', 'Q11879590']);
const STATE_WORD = /\b(empire|kingdom|republic|sultanate|caliphate|khanate|emirate|states?|dynasty|confederation|principality|duchy|league)\b/i;

/** Below this, the name is left unmatched. */
const MATCH = 6;
/** Above this, the French name replaces the English one on the map. */
const CONFIDENT = 10;
const FAILED_RETRY_MS = 3_600_000;
/**
 * Cached cards and region lists are served at once; past this age they are
 * fetched again in the background, and replaced if Wikidata changed.
 */
const REFRESH_MS = 14 * 86_400_000;
/** Names that matched nothing are tried again after this (Wikidata grows). */
const MISS_RETRY_MS = 7 * 86_400_000;
/** Pause between background lookups: map names are a nicety, Wikimedia's patience is not. */
const BACKGROUND_GAP_MS = 1500;
const HOSTS = ['www.wikidata.org', 'query.wikidata.org', 'en.wikipedia.org', 'fr.wikipedia.org'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Resolution { qid: string | null; score: number; labelFr: string | null; labelEn?: string | null; at?: number; v?: number }
/** Bump when matching changes: older matches are looked up again. */
const MATCH_VERSION = 2;
interface CachedDetails extends PolityDetails {
  summary: { text: string; lang: string; url: string; title: string } | null;
  at?: number;
}
interface CachedSubdivisions { at: number; rows: SubdivisionRow[] }
interface CacheFile {
  resolutions: Record<string, Resolution>;
  details: Record<string, CachedDetails>;
  subdivisions: Record<string, CachedSubdivisions>;
}

const range = (xs: number[], pick: (...v: number[]) => number) => (xs.length ? pick(...xs) : null);

// ---------- regions inside a territory ----------

/** Class names of regions (English, as Wikidata labels them). */
const REGION = /\b(provinces?|duch(y|ies)|county|counties|countship|eyalet|vilayet|satrap\w*|regions?|principalit(y|ies)|principate|margraviate|landgraviate|theme|governorate|voivodeship|oblast|shire|earldom|march|prefecture|commandery|lordship|seigneury|states?|kingdom|electorate|bishopric|hochstift|imperial city|imperial abbey|circle|district|department|canton|territory|emirate|beylik|sanjak|khanate|viceroyalty|captaincy|intendancy|bailiwick|seneschalty|fief|barony|viscount\w*|marquisate|colony|protectorate|historical country|administrative territorial entity|dependency|vassal|nome|realm|appanage)\b/i;
/** Classes that are never regions: places, buildings, people, documents, types. */
const NOT_REGION = /\b(transcontinental|continent|geographic region|city|town|village|commune|municipality|settlement|building|church|castle|family|dynasty|title|office|edict|treaty|war|battle|type|position|legislature|parliament|court|school|university|college|monastery|river|mountain|lake|person|organization|company)\b/i;
/** ...except these, which are states of their own (free imperial cities, city-states). */
const CITY_STATE = /\b(imperial city|city-state|free city)\b/i;
const MAX_REGIONS = 120;

/** Region-like rows with a place: the part of the list worth caching, whatever the year. */
export function regionRows(rows: SubdivisionRow[], parent: string): SubdivisionRow[] {
  return rows.filter((r) => {
    if (r.qid === parent || r.lat === null || r.lon === null) return false;
    if (r.classes.some((c) => NOT_REGION.test(c) && !CITY_STATE.test(c))) return false;
    return r.classes.some((c) => REGION.test(c) || CITY_STATE.test(c));
  });
}

/**
 * Regions of a territory at a year (exported for tests): valid then, and
 * only the top level (a county inside a listed duchy is left for the duchy).
 */
export function regionsAt(rows: SubdivisionRow[], parent: string, year: number): SubdivisionItem[] {
  const spans = regionRows(rows, parent).map((r) => {
    // The link's own dates ("part of X from 1477") say more than the region's lifetime.
    const start = range(r.linkStarts, Math.min) ?? range(r.starts, Math.min);
    const end = range(r.linkEnds, Math.max) ?? range(r.ends, Math.max);
    return { r, start, end };
  });
  const valid = spans.filter(({ start, end }) => (start === null || start <= year + 10) && (end === null || end >= year - 10));
  const ids = new Set(valid.map((v) => v.r.qid));
  return valid
    .filter(({ r }) => !r.parents.some((p) => p !== parent && ids.has(p)))
    .sort((a, b) => b.r.sitelinks - a.r.sitelinks)
    .slice(0, MAX_REGIONS)
    .map(({ r, start, end }) => ({
      qid: r.qid,
      label: r.labelFr ?? r.labelEn ?? r.qid,
      kind: r.classes.find((c) => REGION.test(c) || CITY_STATE.test(c)) ?? null,
      lat: r.lat!,
      lon: r.lon!,
      start,
      end,
    }));
}

/** Score of a candidate item for a snapshot name at a year (exported for tests). */
export function scoreCandidate(c: PolityCandidate, name: string, year: number): number {
  let s = Math.log10(c.sitelinks + 1) * 1.5;
  if (c.classes.some((k) => JUNK.has(k))) return -100;
  if (c.classes.some((k) => STATE.has(k))) s += 4;
  else if (c.classes.some((k) => PEOPLE.has(k))) s += 2.5;
  if (c.classes.includes(HISTORICAL_COUNTRY)) s += 1;
  if (c.classes.some((k) => CITY.has(k))) s -= 5;
  s += Math.min(3, c.stateProps);
  const start = range(c.starts, Math.min);
  const end = range(c.ends, Math.max);
  if (start !== null || end !== null) {
    const a = start ?? -Infinity;
    const b = end ?? Infinity;
    if (year >= a - 30 && year <= b + 30) s += 4 + (end !== null || year > 1900 ? 1 : 0);
    else s -= Math.min(6, (year < a ? a - year : year - b) / 100);
    // A state that still exists is rarely the right match long ago (France vs Kingdom of France).
    if (end === null && year < 1800 && (start === null || start < year - 30)) s -= 2;
  }
  // Snapshot names are loosely spelled ("Mamluke Sultanate", "Castille"): reward close names.
  s += 3 * Math.max(nameSimilarity(name, c.labelEn ?? ''), nameSimilarity(name, c.labelFr ?? ''));
  return s;
}

/** Words that say what kind of state it is, not which one ("Kingdom of Castile" ~ "Castille"). */
const GENERIC = new Set([
  'the', 'of', 'and', 'des', 'de', 'du', 'la', 'le', 'kingdom', 'empire', 'republic', 'royaume', 'republique', 'state', 'states',
]);
const tokens = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !GENERIC.has(t));

/** Share of words in common, a word matching another spelled a little differently. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const close = (x: string, y: string) =>
    x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y.slice(0, -1)) || y.startsWith(x.slice(0, -1))));
  const hits = ta.filter((x) => tb.some((y) => close(x, y))).length;
  return hits / Math.max(ta.length, tb.length);
}

/** Rulers at `year`, else the closest reigns before and after (exported for tests). */
export function rulersAt(rulers: PolityDetails['rulers'], year: number): PolityRulerInfo[] {
  const dated = rulers
    .filter((r) => r.start !== null || r.end !== null)
    .map((r) => ({ ...r, a: r.start ?? r.end! - 1 }))
    .sort((x, y) => x.a - y.a);
  const spans = dated.map((r, i) => {
    // Open reigns end when the next ruler starts.
    const next = dated.slice(i + 1).find((n) => n.qid !== r.qid && n.a > r.a);
    return { ...r, b: r.end ?? Math.min(next?.a ?? r.a + 40, r.a + 60) };
  });
  const out = (r: (typeof spans)[number], when: PolityRulerInfo['when']): PolityRulerInfo => ({
    qid: r.qid, name: r.name, office: r.office, start: r.start, end: r.end, image: r.image, when,
  });
  const now = new Map<string, PolityRulerInfo>();
  for (const r of spans) if (r.a <= year && year <= r.b && !now.has(r.qid)) now.set(r.qid, out(r, 'now'));
  if (now.size) return [...now.values()].slice(0, 3);
  // Wikidata's lists have gaps: only neighbors within a generation are worth showing.
  const before = spans.filter((r) => r.b < year && year - r.b <= 30).at(-1);
  const after = spans.find((r) => r.a > year && r.a - year <= 30);
  return [...(before ? [out(before, 'before')] : []), ...(after ? [out(after, 'after')] : [])];
}

const KIND_WORD = /empire|royaume|république|sultanat|califat|khanat|émirat|cité|principauté|duché|confédération|dynastie|état/i;

export class PolityService {
  private cache: CacheFile = { resolutions: {}, details: {}, subdivisions: {} };
  /** Background refreshes of stale entries, run after the map names. */
  private chores = new Map<string, () => Promise<unknown>>();
  private inflight = new Map<string, Promise<Resolution | null>>();
  private failed = new Map<string, number>();
  private queue: { name: string; year: number }[] = [];
  private queued = new Set<string>();
  private working = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private names = new Map<string, string[]>();
  /** Territory cards being prepared: background lookups wait for them. */
  private interactive = 0;

  constructor(private file: string | null, private bordersDir: string) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheFile>;
        this.cache = { resolutions: raw.resolutions ?? {}, details: raw.details ?? {}, subdivisions: raw.subdivisions ?? {} };
      } catch {
        /* corrupt cache: rebuilt on demand */
      }
    }
  }

  /** Card for a territory clicked at `year`. */
  async info(name: string, year: number): Promise<PolityInfo> {
    this.interactive++;
    try {
      return await interactive(() => this.build(name, year));
    } finally {
      this.interactive--;
    }
  }

  /** Card for a region picked from a territory's subdivisions (its item is known). */
  async infoById(qid: string, year: number): Promise<PolityInfo> {
    this.interactive++;
    try {
      const d = await interactive(() => this.details(qid));
      return this.card(d?.labelFr ?? d?.labelEn ?? qid, d, year);
    } finally {
      this.interactive--;
    }
  }

  /** Regions of a territory at a year; the list is cached per territory. */
  async subdivisions(qid: string, year: number): Promise<SubdivisionsResponse> {
    this.interactive++;
    try {
      let hit = this.cache.subdivisions[qid];
      if (!hit) hit = await interactive(() => this.fetchSubdivisions(qid));
      else if (Date.now() - hit.at > REFRESH_MS) this.chore(`s:${qid}`, () => this.fetchSubdivisions(qid));
      return { qid, year, items: regionsAt(hit.rows, qid, year) };
    } finally {
      this.interactive--;
    }
  }

  private async fetchSubdivisions(qid: string): Promise<CachedSubdivisions> {
    const entry = { at: Date.now(), rows: regionRows(await polity.subdivisions(qid), qid) };
    const prev = this.cache.subdivisions[qid];
    if (prev && JSON.stringify(prev.rows) !== JSON.stringify(entry.rows)) console.log(`[polity] regions of ${qid} updated from Wikidata`);
    this.cache.subdivisions[qid] = entry;
    this.scheduleSave();
    return entry;
  }

  private async build(name: string, year: number): Promise<PolityInfo> {
    const res = await this.resolve(name, year);
    const d = res?.qid ? await this.details(res.qid) : null;
    return this.card(name, d, year);
  }

  private card(name: string, d: CachedDetails | null, year: number): PolityInfo {
    const base: PolityInfo = {
      name, year, qid: null, title: name, kind: null, description: null, start: null, end: null, emblem: null,
      image: null, capital: null, government: [], religion: [], languages: [], rulers: [], summary: null,
      summaryLang: null, sources: [],
    };
    if (!d) return base;
    const capital =
      d.capitals.find((c) => (c.start ?? -Infinity) <= year && year <= (c.end ?? Infinity) && (c.start !== null || c.end !== null))
      ?? (d.capitals.length === 1 ? d.capitals[0] : undefined);
    const sources = [{ title: `Wikidata : ${d.labelFr ?? d.labelEn ?? d.qid}`, url: `https://www.wikidata.org/wiki/${d.qid}` }];
    if (d.summary) sources.unshift({ title: `Wikipédia : ${d.summary.title}`, url: d.summary.url });
    return {
      ...base,
      qid: d.qid,
      title: d.labelFr ?? d.labelEn ?? name,
      kind: d.kinds.find((k) => KIND_WORD.test(k)) ?? d.kinds[0] ?? null,
      description: d.description,
      start: range(d.starts, Math.min),
      end: range(d.ends, Math.max),
      emblem: d.flag ?? d.coatOfArms,
      image: d.image,
      capital: capital?.label ?? null,
      government: d.government.slice(0, 3),
      religion: d.religion.slice(0, 3),
      languages: d.languages.slice(0, 4),
      rulers: rulersAt(d.rulers, year),
      summary: d.summary?.text ?? null,
      summaryLang: d.summary?.lang ?? null,
      sources,
    };
  }

  /** French names for a snapshot's territories; unknown ones are looked up in the background. */
  labels(year: number): PolityLabels {
    const snap = snapshotFor(listSnapshots(this.bordersDir), year);
    if (!snap) return { labels: {}, pending: 0 };
    const labels: Record<string, string> = {};
    for (const name of this.snapshotNames(snap.file)) {
      const r = this.cache.resolutions[key(name, snap.year)];
      const stale = r && (r.v !== MATCH_VERSION || (!r.qid && Date.now() - (r.at ?? 0) > MISS_RETRY_MS));
      if (stale) {
        delete this.cache.resolutions[key(name, snap.year)];
        this.enqueue(name, snap.year);
      } else if (r) {
        // Renaming on the map needs a sure match: same name, only translated.
        if (r.labelFr && r.score >= CONFIDENT && nameSimilarity(name, r.labelEn ?? '') >= 0.75) labels[name] = r.labelFr;
      } else this.enqueue(name, snap.year);
    }
    return { labels, pending: this.queue.length + (this.working ? 1 : 0) };
  }

  private snapshotNames(file: string): string[] {
    let names = this.names.get(file);
    if (!names) {
      const geo = JSON.parse(readFileSync(file, 'utf8')) as { features: { properties: { NAME?: string | null } }[] };
      names = [...new Set(geo.features.map((f) => f.properties.NAME?.trim()).filter((n): n is string => !!n))];
      this.names.set(file, names);
    }
    return names;
  }

  private enqueue(name: string, year: number): void {
    const k = key(name, year);
    if (this.queued.has(k) || (this.failed.get(k) ?? 0) > Date.now()) return;
    this.queued.add(k);
    this.queue.push({ name, year });
    background(() => void this.work()); // a lookup queued from a click does not keep its priority
  }

  /** One lookup at a time: labels are a nicety, Wikidata's time is shared. */
  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    while (this.queue.length || this.chores.size) {
      // Yield to someone clicking a territory, and wait when Wikimedia asked us to.
      const cool = Math.max(...HOSTS.map(coolingUntil)) - Date.now();
      if (cool > 0) await sleep(cool + 2000);
      while (this.interactive > 0) await sleep(500);
      const job = this.queue.shift();
      if (job) {
        const r = await this.resolve(job.name, job.year).catch(() => null);
        // Prepare the card too, so the first click on the territory is instant.
        if (r?.qid && !this.cache.details[r.qid]) {
          while (this.interactive > 0) await sleep(500);
          await this.details(r.qid).catch(() => null);
        }
        this.queued.delete(key(job.name, job.year));
      } else {
        const [k, chore] = this.chores.entries().next().value!;
        this.chores.delete(k);
        await chore().catch((e) => console.warn(`[polity] refresh ${k} failed: ${(e as Error).message}`));
      }
      await sleep(BACKGROUND_GAP_MS);
    }
    this.working = false;
  }

  /** Queues a background refresh (once per key). */
  private chore(k: string, run: () => Promise<unknown>): void {
    if (this.chores.has(k)) return;
    this.chores.set(k, run);
    background(() => void this.work()); // a lookup queued from a click does not keep its priority
  }

  private resolve(name: string, year: number): Promise<Resolution | null> {
    const k = key(name, year);
    const hit = this.cache.resolutions[k];
    if (hit && hit.v === MATCH_VERSION) return Promise.resolve(hit);
    let p = this.inflight.get(k);
    if (!p) {
      p = this.lookup(name, year)
        .then((r) => {
          this.cache.resolutions[k] = { ...r, at: Date.now(), v: MATCH_VERSION };
          this.scheduleSave();
          return r;
        })
        .catch((e) => {
          console.warn(`[polity] lookup failed for ${name}: ${(e as Error).message}`);
          this.failed.set(k, Date.now() + FAILED_RETRY_MS);
          return null;
        })
        .finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }

  private async lookup(name: string, year: number): Promise<Resolution> {
    const safe = (p: Promise<string[]>) => p.catch(() => [] as string[]);
    const seen = new Set<string>();
    const best = { c: null as PolityCandidate | null, s: -Infinity };
    const consider = async (ids: string[]) => {
      const fresh = ids.filter((id) => !seen.has(id)).slice(0, 30);
      fresh.forEach((id) => seen.add(id));
      for (const c of await polity.candidateFacts(fresh)) {
        const s = scoreCandidate(c, name, year);
        if (s > best.s) Object.assign(best, { c, s });
      }
    };
    // Wikimedia rate-limits bursts: two searches first, variants only when needed.
    await consider([
      ...(await safe(polity.searchIds(name))),
      ...(await safe(polity.articleIds(`${name} ${year < 0 ? 'ancient' : 'history'}`))),
    ]);
    // A country that still exists wins on fame; long ago, its kingdom or empire is often the one meant.
    const modern = best.c !== null && best.c.ends.length === 0 && year < 1800;
    if (best.s < CONFIDENT || modern) {
      const more = [...(await safe(polity.searchIds(name, 'fr', 4)))];
      if (!STATE_WORD.test(name)) {
        more.push(...(await safe(polity.searchIds(`Kingdom of ${name}`))), ...(await safe(polity.searchIds(`${name} Empire`))));
      }
      await consider(more);
    }
    if (!best.c || best.s < MATCH) return { qid: null, score: Math.max(0, best.s), labelFr: null, labelEn: null };
    return { qid: best.c.qid, score: Math.round(best.s * 10) / 10, labelFr: best.c.labelFr, labelEn: best.c.labelEn };
  }

  private async details(qid: string): Promise<CachedDetails | null> {
    const hit = this.cache.details[qid];
    if (hit) {
      if (Date.now() - (hit.at ?? 0) > REFRESH_MS) this.chore(`d:${qid}`, () => this.fetchDetails(qid));
      return hit;
    }
    return this.fetchDetails(qid);
  }

  /** Fetches a card's facts; a refresh replaces the cached card, and says so if something changed. */
  private async fetchDetails(qid: string): Promise<CachedDetails | null> {
    const d = await polity.polityDetails(qid);
    if (!d) return null;
    let summary: CachedDetails['summary'] = null;
    for (const [lang, title] of [['fr', d.frTitle], ['en', d.enTitle]] as const) {
      if (!title) continue;
      const s = await wikipedia.pageSummary(lang, title).catch(() => null);
      if (s) {
        summary = { text: s.extract, lang, url: s.url, title: s.title };
        break;
      }
    }
    const out: CachedDetails = { ...d, summary, at: Date.now() };
    const prev = this.cache.details[qid];
    if (prev) {
      const { at: _a, ...before } = prev;
      const { at: _b, ...after } = out;
      if (JSON.stringify(before) !== JSON.stringify(after)) console.log(`[polity] card ${qid} updated from Wikidata`);
    }
    this.cache.details[qid] = out;
    this.scheduleSave();
    return out;
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify(this.cache));
      } catch (e) {
        console.warn('[polity] could not save cache:', (e as Error).message);
      }
    }, 5000);
    this.saveTimer.unref();
  }
}

/** Matches depend on the era: "Egypt" is not the same state in −1000 and 1500. */
const key = (name: string, year: number) => `${name}|${Math.floor(year / 100)}`;
