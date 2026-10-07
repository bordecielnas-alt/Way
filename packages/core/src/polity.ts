import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  background, coolingUntil, interactive, polity, wikipedia, type PolityCandidate, type PolityDetails, type SubdivisionRow,
} from '@way/providers';
import {
  faithByName, type Culture, type CulturesResponse, type EmblemsResponse, type Faith, type FaithsResponse, type PolityInfo, type PolityLabels,
  type PolityRulerInfo, type SubdivisionItem, type SubdivisionsResponse,
} from '@way/shared';
import type { DatedFaith, DatedFile, ItemEmblems } from '@way/providers';
import { listSnapshots, snapshotFor, SNAPSHOTS_BEFORE } from './borders.ts';
import type { Cliopatria } from './cliopatria.ts';

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
 * Cached cards and region lists are served at once; past the age set in the
 * Réglages page (180 days by default) they are fetched again in the
 * background, and replaced if Wikidata changed.
 */
const DEFAULT_REFRESH_MS = 180 * 86_400_000;
/** Names that matched nothing are tried again after this (Wikidata grows). */
const MISS_RETRY_MS = 30 * 86_400_000;
/** Realms whose card is prepared in the background when a period is shown (the largest ones). */
const WARM_CARDS = 10;
/** What was looked up and not found (no emblem, no French name, no faith) is asked again after this. */
const MISSING_RETRY_MS = 3 * 86_400_000;
/** The refining sweep wakes up this often, and does something only when nothing else waits. */
const REFINE_EVERY_MS = 90_000;
/** Items handed to each queue per sweep: small, so a click never waits long behind it. */
const REFINE_BATCH = 50;
/**
 * Interest in a realm (its clicks) halves over this: France clicked every day
 * stays among the watched realms, a realm clicked once last year does not.
 */
const INTEREST_HALF_LIFE_MS = 14 * 86_400_000;
/** Freshness asked of the most watched realms: never checked more often than this. */
const HOT_FRESH_MS = 86_400_000;
const HOT_MISSING_MS = 6 * 3_600_000;
/** Watched realms whose card and regions the sweep also checks, each time. */
const REFINE_HOT = 3;
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
interface CachedLabel { fr: string | null; en: string | null; start?: number | null; end?: number | null; at: number }
interface CachedEmblems extends ItemEmblems { at: number; v?: number }
interface CachedFaiths { list: DatedFaith[]; at: number; v?: number }
/** Slack on an item's dates: borders and Wikidata rarely agree to the year. */
const ERA_SLACK = 50;
/** Whether an item's lifetime covers a year (undated items are trusted). */
export function fitsEra(start: number | null | undefined, end: number | null | undefined, year: number): boolean {
  return (start == null || start <= year + ERA_SLACK) && (end == null || end >= year - ERA_SLACK);
}
interface CacheFile {
  resolutions: Record<string, Resolution>;
  details: Record<string, CachedDetails>;
  subdivisions: Record<string, CachedSubdivisions>;
  /** Labels of the yearly borders' items (their Wikidata ids are known). */
  labels: Record<string, CachedLabel>;
  /** Coats of arms and flags of those items. */
  emblems: Record<string, CachedEmblems>;
  /** Religions of those items (the religious backdrop). */
  faiths: Record<string, CachedFaiths>;
  /** Peoples and languages of those items (the culture backdrop), kept as faiths are. */
  cultures: Record<string, CachedFaiths>;
  /** Clicks on each realm (decayed score and when last counted): the refresh follows them. */
  interest: Record<string, { n: number; at: number }>;
}

/** Invented or reconstructed emblems: not shown as the real thing. */
const FICTIONAL = /\b(fictitious|fictional|fantasy|hypothetical|imaginary|invented)\b/i;

/** Years a file's name gives ("Flag of Spain (1873–1874)", "Flag of Herat until 1842"). */
export function nameYears(file: string): { start: number | null; end: number | null } {
  const range = /\b(\d{3,4})\s*(?:–|—|-|to)\s*(\d{3,4})\b/.exec(file);
  if (range) return { start: Number(range[1]), end: Number(range[2]) };
  const until = /\b(?:until|before|to)\s+(\d{3,4})\b/i.exec(file);
  if (until) return { start: null, end: Number(until[1]) };
  const since = /\b(?:since|from|after)\s+(\d{3,4})\b/i.exec(file);
  if (since) return { start: Number(since[1]), end: null };
  return { start: null, end: null };
}

/** Years an item existed (a realm of the past has an end; today's country has none). */
export interface Lifespan { start: number | null; end: number | null }

/**
 * The file in use at a year, only when a source dates it: a statement dated
 * for that year first; else an undated one whose name gives years around it,
 * or that belongs to a realm of the past alive then. Today's country without
 * dates on its flag gets nothing (its current flag is not the one of 1806).
 */
export function fileAt(files: DatedFile[], year: number, life: Lifespan = { start: null, end: null }): string | null {
  // Its name says another era: not that one, whatever the statement's dates.
  const real = files.filter((f) => !FICTIONAL.test(f.file) && !laterDesign(f.file, year) && nameFits(f.file, year));
  const dated = real.filter((f) => f.start !== null || f.end !== null);
  const now = dated
    .filter((f) => (f.start ?? -Infinity) <= year && year <= (f.end ?? Infinity))
    .sort((a, b) => (b.start ?? -Infinity) - (a.start ?? -Infinity))[0];
  if (now) return now.file;
  const bounded = life.end !== null && (life.start ?? -Infinity) - 5 <= year && year <= life.end + 5;
  const sourced = (f: DatedFile) => {
    const n = nameYears(f.file);
    return bounded || n.start !== null || n.end !== null;
  };
  return real.find((f) => f.start === null && f.end === null && sourced(f))?.file ?? null;
}

/** The years in a file's name (if any) take in the year, give or take five. */
function nameFits(file: string, year: number): boolean {
  const n = nameYears(file);
  return (n.start === null || n.start <= year + 5) && (n.end === null || n.end >= year - 5);
}

/** A lone year in the name well after the year shown ("Arms of Prussia 1873" for 1806): a later design. */
function laterDesign(file: string, year: number): boolean {
  const n = nameYears(file);
  if (n.start !== null || n.end !== null) return false;
  const years = [...file.matchAll(/(?<![\d–-])(1[0-9]{3}|20[0-9]{2})(?![\d–-])/g)].map((m) => Number(m[1]));
  return years.length === 1 && years[0]! > year + 25;
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

/** Words of titles, not of places ("Sultanate of Bone": only "bone" names the place). */
const TITLE_WORDS = new Set([
  'sultanate', 'sultan', 'kingdom', 'king', 'empire', 'emperor', 'principality', 'prince', 'duchy', 'duke', 'county', 'count',
  'republic', 'dynasty', 'khanate', 'khan', 'emirate', 'emir', 'caliphate', 'caliph', 'grand', 'margraviate', 'lordship',
  'shogunate', 'confederation', 'city', 'states', 'crown', 'house',
]);

/**
 * Whether an item's English label names the same place as the dataset's name
 * (the dataset sometimes links the office, "sultan", instead of the realm).
 */
export function sameplace(name: string, labelEn: string | null): boolean {
  if (!labelEn) return true;
  const core = tokens(name).filter((t) => !TITLE_WORDS.has(t));
  if (!core.length) return true;
  const other = tokens(labelEn);
  return core.some((x) => other.some((y) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y.slice(0, -1)) || y.startsWith(x.slice(0, -1))))));
}

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

/** A statement dated around a year counts; with none, one dated less than this far away is better than nothing. */
const NEAR_YEARS = 200;

/**
 * The statements that speak for a year: those dated around it, else the
 * undated ones (also when those dated name no known family: Hungary's
 * "Latin of the kingdom" dated 1000–1844 does not hide its Hungarian); then
 * the dated ones nearest the year (up to NEAR_YEARS away): the Roman
 * Republic of −100 is told by the cults dated from −27 rather than by an
 * undated "other".
 */
function poolAt(list: DatedFaith[], year: number): DatedFaith[] {
  const fits = (f: DatedFaith) => (f.start === null || f.start <= year) && (f.end === null || f.end >= year);
  const known = (pool: DatedFaith[]) => pool.some((f) => f.faith !== 'other');
  const dated = list.filter((f) => (f.start !== null || f.end !== null) && fits(f));
  const undated = list.filter((f) => f.start === null && f.end === null);
  const pool = known(dated) ? dated : known(undated) ? undated : dated.length ? dated : undated;
  if (known(pool)) return pool;
  const away = (f: DatedFaith) => (f.end !== null && f.end < year ? year - f.end : f.start !== null && f.start > year ? f.start - year : 0);
  const near = list.filter((f) => f.faith !== 'other' && (f.start !== null || f.end !== null) && away(f) <= NEAR_YEARS);
  const best = Math.min(...near.map(away));
  return near.length ? near.filter((f) => away(f) === best) : pool;
}

/** The family with the most weight in a pool ("ancient" cults do not add up); "other" when none is known, null when empty. */
function heaviest(pool: DatedFaith[]): string | null {
  if (!pool.length) return null;
  const score = new Map<string, number>();
  for (const f of pool) {
    if (f.faith === 'other') continue;
    const w = f.weight ?? 1;
    // "Ancient" gathers distinct cults (Greek, Babylonian, Egyptian…), not one faith: they do not add up.
    score.set(f.faith, f.faith === 'ancient' ? Math.max(score.get(f.faith) ?? 0, w) : (score.get(f.faith) ?? 0) + w);
  }
  let best: string | null = null;
  for (const [f, n] of score) if (best === null || n > score.get(best)!) best = f;
  return best ?? 'other';
}

/** The realm's own statements first; its kin's only when its own name no known family. */
function ownFirst(list: DatedFaith[], year: number, pick: (pool: DatedFaith[]) => string | null): string | null {
  const own = pick(poolAt(list.filter((f) => !f.kin), year));
  if (own && own !== 'other') return own;
  return pick(poolAt(list.filter((f) => f.kin), year)) ?? own;
}

/**
 * The faith in force at a year: among statements dated around it (else the
 * undated ones, else the nearest dated), the known family with the most
 * weight (preferred rank, official religion, number of statements); the
 * realm's kin speak only when it says nothing; "other" only when nothing else.
 */
export function faithAt(list: DatedFaith[], year: number): Faith | null {
  return ownFirst(list, year, heaviest) as Faith | null;
}

/** Below this share of its best source, a realm's first family does not speak for it: "mixed". */
const MIXED_SHARE = 0.5;
const SOURCES = ['people', 'official', 'used'] as const;

/**
 * A realm's people at a year, as a family: its people if Wikidata gives it,
 * else its official languages, else those used; a learned language (Latin
 * in Poland) speaks only when the realm states no other;
 * "mixed" when no family holds half of that source among three or more
 * (the Holy Roman Empire, Austria-Hungary).
 */
export function cultureAt(list: DatedFaith[], year: number): Culture | null {
  return ownFirst(list, year, (pool) => {
    const spoken = pool.filter((f) => f.faith !== 'other' && !f.learned);
    const use = spoken.length ? spoken : pool.filter((f) => f.faith !== 'other');
    const source = SOURCES.find((h) => use.some((f) => (f.how ?? 'used') === h));
    if (!source) return heaviest(pool);
    const from = use.filter((f) => (f.how ?? 'used') === source);
    const score = new Map<string, number>();
    for (const f of from) score.set(f.faith, (score.get(f.faith) ?? 0) + (f.weight ?? 1));
    const total = [...score.values()].reduce((x, y) => x + y, 0);
    const [best, n] = [...score].sort((x, y) => y[1] - x[1])[0]!;
    return score.size >= 3 && n < total * MIXED_SHARE ? 'mixed' : best;
  }) as Culture | null;
}

const KIND_WORD = /empire|royaume|république|sultanat|califat|khanat|émirat|cité|principauté|duché|confédération|dynastie|état/i;

export class PolityService {
  private cache: CacheFile = { resolutions: {}, details: {}, subdivisions: {}, labels: {}, emblems: {}, faiths: {}, cultures: {}, interest: {} };
  /** Chores for a realm just clicked: they pass before the rest of the background work. */
  private urgent = new Set<string>();
  private labelQueue = new Set<string>();
  private emblemQueue = new Set<string>();
  private faithQueue = new Set<string>();
  private cultureQueue = new Set<string>();
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

  constructor(
    private file: string | null,
    private bordersDir: string,
    private clio: Cliopatria | null = null,
    private refreshMs: () => number = () => DEFAULT_REFRESH_MS,
  ) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheFile>;
        this.cache = {
          resolutions: raw.resolutions ?? {}, details: raw.details ?? {}, subdivisions: raw.subdivisions ?? {}, labels: raw.labels ?? {},
          emblems: raw.emblems ?? {}, faiths: raw.faiths ?? {}, cultures: raw.cultures ?? {}, interest: raw.interest ?? {},
        };
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

  /**
   * Card for a realm or region whose item is known. With its name, an item
   * of another era (a dataset slip) gives way to a lookup by name.
   */
  async infoById(qid: string, year: number, name?: string): Promise<PolityInfo> {
    this.interactive++;
    try {
      const d = await interactive(() => this.details(qid));
      const ends = d?.ends.length ? Math.max(...d.ends) : null;
      const starts = d?.starts.length ? Math.min(...d.starts) : null;
      if (name && (!d || !fitsEra(starts, ends, year))) return await interactive(() => this.build(name, year));
      this.watch(qid);
      return this.card(name ?? d?.labelFr ?? d?.labelEn ?? qid, d, year);
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
      // Opening its regions is looking closely at a realm: it counts, less than a click.
      this.watch(qid, 0.5);
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
    if (res?.qid) this.watch(res.qid);
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

  /** French names for the territories shown at a year; unknown ones are looked up in the background. */
  labels(year: number): PolityLabels {
    const period = year >= SNAPSHOTS_BEFORE ? this.clio?.period(year) : null;
    if (period) return this.periodLabels(period.features, period.from);
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

  /**
   * Yearly borders carry their Wikidata item: labels come in batches of 50
   * (no guessing). The era's own name wins when the item's label is another
   * era's (Northern Song under "Song"); it is then put in French by pattern.
   */
  private periodLabels(features: { name: string; qid: string | null; area: number }[], year: number): PolityLabels {
    const labels: Record<string, string> = {};
    for (const f of features) {
      const hit = f.qid ? this.cache.labels[f.qid] : undefined;
      // Labels cached before dates were kept are fetched again.
      if (f.qid && this.labelStale(f.qid)) this.labelQueue.add(f.qid);
      const fr = this.itemFits(f, year) ? hit!.fr : null;
      const name = fr ?? frenchTitle(f.name);
      if (name && name !== f.name) labels[f.name] = name;
    }
    // The biggest realms get their card ready: the first click on them is instant.
    for (const f of [...features].sort((a, b) => b.area - a.area).slice(0, WARM_CARDS)) {
      const l = f.qid ? this.cache.labels[f.qid] : undefined;
      if (f.qid && l && fitsEra(l.start, l.end, year) && !this.cache.details[f.qid]) this.chore(`d:${f.qid}`, () => this.fetchDetails(f.qid!));
    }
    if (this.labelQueue.size) this.chore('labels', () => this.fetchLabels());
    return { labels, pending: this.labelQueue.size };
  }

  /**
   * Whether a feature's item is really that realm at that year: the dataset
   * sometimes links another era's item (the Restoration for the medieval
   * kingdom) or the office ("sultan") instead of the realm.
   */
  private itemFits(f: { name: string; qid: string | null }, year: number): boolean {
    const hit = f.qid ? this.cache.labels[f.qid] : undefined;
    if (!hit || !fitsEra(hit.start, hit.end, year)) return false;
    return sameplace(f.name, hit.en ?? null) && (!this.clio?.ambiguous(f.qid!) || nameSimilarity(f.name, hit.en ?? '') >= 0.75);
  }

  /**
   * Coats of arms and flags of the realms shown at a year (by item), for
   * the watermarks on the map. Unknown ones are looked up in the background.
   */
  emblems(year: number): EmblemsResponse {
    const period = year >= SNAPSHOTS_BEFORE ? this.clio?.period(year) : null;
    if (!period) return { emblems: {}, pending: 0 };
    // Only items known to be the right realm (their names are checked first).
    const sure = period.features.filter((f) => f.qid && this.itemFits(f, period.from)).map((f) => f.qid!);
    const unnamed = period.features.some((f) => f.qid && !this.cache.labels[f.qid]);
    const res = this.emblemsOf(sure, period.from);
    return { emblems: res.emblems, pending: res.pending + (unnamed ? 1 : 0) };
  }

  /** Coats of arms and flags of any items at a year (the sides of an army). */
  emblemsOf(qids: string[], year: number): EmblemsResponse {
    const emblems: EmblemsResponse['emblems'] = {};
    for (const qid of new Set(qids)) {
      const hit = this.cache.emblems[qid];
      if (this.emblemStale(qid)) this.emblemQueue.add(qid);
      if (!hit) continue;
      const life = { start: hit.start ?? null, end: hit.end ?? null };
      const coa = fileAt(hit.coa, year, life);
      const flag = fileAt(hit.flag, year, life);
      if (coa || flag) emblems[qid] = { coa, flag };
    }
    if (this.emblemQueue.size) this.chore('emblems', () => this.fetchEmblems());
    return { emblems, pending: this.emblemQueue.size };
  }

  /**
   * Faith of each realm shown at a year (official religion, else the
   * religion Wikidata gives it), for the religious backdrop. Unknown ones
   * are looked up in the background.
   */
  faiths(year: number): FaithsResponse {
    const period = year >= SNAPSHOTS_BEFORE ? this.clio?.period(year) : null;
    if (!period) return { faiths: {}, pending: 0 };
    const faiths: FaithsResponse['faiths'] = {};
    for (const f of period.features) {
      const qid = f.qid;
      if (!qid || faiths[qid] || !this.itemFits(f, period.from)) continue;
      const hit = this.cache.faiths[qid];
      if (this.faithStale(qid)) this.faithQueue.add(qid);
      const found = hit ? faithAt(hit.list, period.from) : null;
      // Nothing known: its name may say it (a caliphate, a prince-bishopric).
      const l = this.cache.labels[qid];
      const named = !found || found === 'other' ? faithByName([f.name, l?.en, l?.fr].filter(Boolean).join(' · ')) : null;
      const faith = named ?? found;
      if (faith) faiths[qid] = faith;
    }
    const unnamed = period.features.some((f) => f.qid && !this.cache.labels[f.qid]);
    if (this.faithQueue.size) this.chore('faiths', () => this.fetchFaiths());
    return { faiths, pending: this.faithQueue.size + (unnamed ? 1 : 0) };
  }

  /**
   * The people of each realm shown at a year (its ethnic group, else its
   * languages), as a family, for the culture backdrop. Unknown ones are
   * looked up in the background, as faiths are.
   */
  cultures(year: number): CulturesResponse {
    const period = year >= SNAPSHOTS_BEFORE ? this.clio?.period(year) : null;
    if (!period) return { cultures: {}, pending: 0 };
    const cultures: CulturesResponse['cultures'] = {};
    for (const qid of new Set(period.features.filter((f) => f.qid && this.itemFits(f, period.from)).map((f) => f.qid!))) {
      const hit = this.cache.cultures[qid];
      if (this.cultureStale(qid)) this.cultureQueue.add(qid);
      const c = hit ? cultureAt(hit.list, period.from) : null;
      if (c) cultures[qid] = c;
    }
    const unnamed = period.features.some((f) => f.qid && !this.cache.labels[f.qid]);
    if (this.cultureQueue.size) this.chore('cultures', () => this.fetchCultures());
    return { cultures, pending: this.cultureQueue.size + (unnamed ? 1 : 0) };
  }

  private async fetchCultures(): Promise<void> {
    const ids = this.batch(this.cultureQueue);
    const got = await polity.itemCultures(ids);
    const at = Date.now();
    for (const id of ids) {
      this.cache.cultures[id] = { list: got.get(id) ?? [], at, v: polity.CULTURES_VERSION };
      this.cultureQueue.delete(id);
    }
    this.scheduleSave();
    if (this.cultureQueue.size) this.chore('cultures', () => this.fetchCultures());
  }

  private async fetchFaiths(): Promise<void> {
    const ids = this.batch(this.faithQueue);
    const got = await polity.itemFaiths(ids);
    const at = Date.now();
    for (const id of ids) {
      this.cache.faiths[id] = { list: got.get(id) ?? [], at, v: polity.FAITHS_VERSION };
      this.faithQueue.delete(id);
    }
    this.scheduleSave();
    if (this.faithQueue.size) this.chore('faiths', () => this.fetchFaiths());
  }

  /** A batch for one lookup: the most watched realms first, then in the order they came. */
  private batch(queue: Set<string>): string[] {
    const now = Date.now();
    const ids = [...queue];
    const hot = ids.filter((q) => this.interestOf(q, now) > 0).sort((a, b) => this.interestOf(b, now) - this.interestOf(a, now));
    const hotSet = new Set(hot);
    return [...hot, ...ids.filter((q) => !hotSet.has(q))].slice(0, 200);
  }

  /**
   * Refining sweep, in the background: goes over every realm of the yearly
   * borders (not only the periods viewed) and hands small batches to the
   * lookup queues. The realms looked at lately come first, with their card
   * and regions too (a realm clicked every day is kept up to date); then
   * names (emblems and faiths need them to check the item), missing emblems
   * and faiths, what was found empty a while ago, and what is getting old.
   * It only runs when no lookup waits and nobody is clicking, so the map
   * completes itself without the viewer feeling it.
   */
  startRefining(): void {
    const timer = setInterval(() => this.refine(), REFINE_EVERY_MS);
    timer.unref?.();
  }

  /** One sweep step; returns how many items were queued (0: nothing left, or busy). */
  refine(): number {
    // A few chores waiting is fine (they come and go while someone browses); a click or a name to match is not.
    if (!this.clio || this.interactive > 0 || this.queue.length || this.chores.size > 2) return 0;
    if (Math.max(...HOSTS.map(coolingUntil)) > Date.now()) return 0;
    const watched = this.watched();
    // Cards and regions go one realm at a time: only the few most watched are checked.
    let cards = 0;
    for (const q of watched) {
      if (cards >= REFINE_HOT) break;
      const d = this.cache.details[q] && this.detailsStale(q);
      const s = this.regionsStale(q);
      if (d) this.chore(`d:${q}`, () => this.fetchDetails(q));
      if (s) this.chore(`s:${q}`, () => this.fetchSubdivisions(q));
      if (d || s) cards++;
    }
    const order = [...new Set([...watched, ...this.clio.allQids()])];
    const pick = (stale: (q: string) => boolean) => {
      const out: string[] = [];
      for (const q of order) {
        if (out.length >= REFINE_BATCH) break;
        if (stale(q)) out.push(q);
      }
      return out;
    };
    const labels = pick((q) => this.labelStale(q));
    const emblems = pick((q) => !!this.cache.labels[q] && this.emblemStale(q));
    const faiths = pick((q) => !!this.cache.labels[q] && this.faithStale(q));
    const cultures = pick((q) => !!this.cache.labels[q] && this.cultureStale(q));
    for (const q of labels) this.labelQueue.add(q);
    for (const q of emblems) this.emblemQueue.add(q);
    for (const q of faiths) this.faithQueue.add(q);
    for (const q of cultures) this.cultureQueue.add(q);
    if (labels.length) this.chore('labels', () => this.fetchLabels());
    if (emblems.length) this.chore('emblems', () => this.fetchEmblems());
    if (faiths.length) this.chore('faiths', () => this.fetchFaiths());
    if (cultures.length) this.chore('cultures', () => this.fetchCultures());
    const n = labels.length + emblems.length + faiths.length + cultures.length + cards;
    if (n) {
      console.log(`[polity] refining: ${labels.length} names, ${emblems.length} emblems, ${faiths.length} faiths, ${cultures.length} peoples, ${cards} watched cards`);
    }
    return n;
  }

  /** How complete the background knowledge of the realms is (Réglages page). */
  refineStats(): { realms: number; named: number; emblems: number; faiths: number; cultures: number; watched: number } {
    const all = this.clio?.allQids() ?? [];
    let named = 0;
    let emblems = 0;
    let faiths = 0;
    let cultures = 0;
    for (const q of all) {
      if (this.cache.labels[q]?.fr) named++;
      const e = this.cache.emblems[q];
      if (e && (e.coa.length || e.flag.length)) emblems++;
      if (this.cache.faiths[q]?.list.length) faiths++;
      if (this.cache.cultures[q]?.list.length) cultures++;
    }
    return { realms: all.length, named, emblems, faiths, cultures, watched: this.watched().length };
  }

  private async fetchEmblems(): Promise<void> {
    const ids = this.batch(this.emblemQueue);
    const got = await polity.itemEmblems(ids);
    const at = Date.now();
    for (const id of ids) {
      this.cache.emblems[id] = { ...(got.get(id) ?? { coa: [], flag: [], start: null, end: null }), at, v: polity.EMBLEMS_VERSION };
      this.emblemQueue.delete(id);
    }
    this.scheduleSave();
    if (this.emblemQueue.size) this.chore('emblems', () => this.fetchEmblems());
  }

  private async fetchLabels(): Promise<void> {
    const ids = this.batch(this.labelQueue);
    const got = await polity.itemLabels(ids);
    const at = Date.now();
    for (const id of ids) {
      this.cache.labels[id] = { ...(got.get(id) ?? { fr: null, en: null }), at };
      this.labelQueue.delete(id);
    }
    this.scheduleSave();
    if (this.labelQueue.size) this.chore('labels', () => this.fetchLabels());
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
      // A realm just clicked goes before the names still to match and the sweep.
      for (const k of this.urgent) if (!this.chores.has(k)) this.urgent.delete(k);
      const urgent = this.urgent.values().next().value;
      const job = urgent ? undefined : this.queue.shift();
      if (job) {
        const r = await this.resolve(job.name, job.year).catch(() => null);
        // Prepare the card too, so the first click on the territory is instant.
        if (r?.qid && !this.cache.details[r.qid]) {
          while (this.interactive > 0) await sleep(500);
          await this.details(r.qid).catch(() => null);
        }
        this.queued.delete(key(job.name, job.year));
      } else {
        const [k, chore] = urgent ? [urgent, this.chores.get(urgent)!] : this.chores.entries().next().value!;
        this.chores.delete(k);
        this.urgent.delete(k);
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
      if (this.detailsStale(qid)) this.chore(`d:${qid}`, () => this.fetchDetails(qid));
      return hit;
    }
    return this.fetchDetails(qid);
  }

  // ---------- freshness: the more a realm is looked at, the fresher it is kept ----------

  /** Interest in a realm now (its clicks, halved every two weeks). */
  private interestOf(qid: string | null | undefined, now = Date.now()): number {
    const i = qid ? this.cache.interest[qid] : undefined;
    return i ? i.n * 0.5 ** ((now - i.at) / INTEREST_HALF_LIFE_MS) : 0;
  }

  /**
   * Age past which what is known of a realm is checked again: the usual
   * delay (Réglages page) for a realm nobody looks at, down to a day for one
   * clicked again and again. What was looked for and not found is asked
   * again sooner, the same way.
   */
  private freshMs(qid?: string | null): number {
    const n = this.interestOf(qid);
    return Math.max(Math.min(HOT_FRESH_MS, this.refreshMs()), this.refreshMs() / (1 + 4 * n));
  }
  private missingMs(qid?: string | null): number {
    const n = this.interestOf(qid);
    return Math.max(HOT_MISSING_MS, MISSING_RETRY_MS / (1 + 2 * n));
  }

  /** Unknown, from an older lookup, too old, or found empty a while ago (Wikidata fills in). */
  private labelStale(qid: string): boolean {
    const l = this.cache.labels[qid];
    if (!l || l.start === undefined) return true;
    return Date.now() - l.at > (l.fr ? this.freshMs(qid) : this.missingMs(qid));
  }
  private emblemStale(qid: string): boolean {
    const hit = this.cache.emblems[qid];
    if (!hit || !('end' in hit)) return true;
    const age = Date.now() - hit.at;
    if (!hit.coa.length && !hit.flag.length) return hit.v !== polity.EMBLEMS_VERSION || age > this.missingMs(qid);
    return age > this.freshMs(qid);
  }
  private faithStale(qid: string): boolean {
    const hit = this.cache.faiths[qid];
    if (!hit || hit.v !== polity.FAITHS_VERSION) return true;
    return Date.now() - hit.at > (hit.list.length ? this.freshMs(qid) : this.missingMs(qid));
  }
  private cultureStale(qid: string): boolean {
    const hit = this.cache.cultures[qid];
    if (!hit || hit.v !== polity.CULTURES_VERSION) return true;
    return Date.now() - hit.at > (hit.list.length ? this.freshMs(qid) : this.missingMs(qid));
  }
  /** The card: its government and rulers are the political side, looked after like the emblems. */
  private detailsStale(qid: string): boolean {
    const d = this.cache.details[qid];
    if (!d) return true;
    const thin = !d.government.length && !d.rulers.length;
    return Date.now() - (d.at ?? 0) > (thin ? this.missingMs(qid) : this.freshMs(qid));
  }
  private regionsStale(qid: string): boolean {
    const s = this.cache.subdivisions[qid];
    if (!s) return false; // regions are only kept for realms someone opened
    return Date.now() - s.at > (s.rows.length ? this.freshMs(qid) : this.missingMs(qid));
  }

  /**
   * A realm was clicked: it counts one more view, and whatever is out of
   * date for it (name, emblems, faith, card, regions) is refreshed first
   * among the background work, right after the answer.
   */
  private watch(qid: string, weight = 1): void {
    const now = Date.now();
    this.cache.interest[qid] = { n: this.interestOf(qid, now) + weight, at: now };
    this.scheduleSave();
    this.freshen(qid, true);
  }

  /** Queues the lookups a realm needs; `first`: ahead of the other chores. */
  private freshen(qid: string, first = false): number {
    let n = 0;
    const add = (k: string, run: () => Promise<unknown>) => {
      n++;
      if (first) this.urgent.add(k);
      this.chore(k, run);
    };
    if (this.labelStale(qid)) {
      this.labelQueue.add(qid);
      add('labels', () => this.fetchLabels());
    }
    if (this.emblemStale(qid)) {
      this.emblemQueue.add(qid);
      add('emblems', () => this.fetchEmblems());
    }
    if (this.faithStale(qid)) {
      this.faithQueue.add(qid);
      add('faiths', () => this.fetchFaiths());
    }
    if (this.cultureStale(qid)) {
      this.cultureQueue.add(qid);
      add('cultures', () => this.fetchCultures());
    }
    if (this.cache.details[qid] && this.detailsStale(qid)) add(`d:${qid}`, () => this.fetchDetails(qid));
    if (this.regionsStale(qid)) add(`s:${qid}`, () => this.fetchSubdivisions(qid));
    return n;
  }

  /** Realms looked at lately, most watched first. */
  private watched(): string[] {
    const now = Date.now();
    return Object.keys(this.cache.interest)
      .map((q) => [q, this.interestOf(q, now)] as const)
      .filter(([, n]) => n >= 0.25)
      .sort((a, b) => b[1] - a[1])
      .map(([q]) => q);
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

/** Titles put in French, the place name kept ("Duchy of Athens" → "duché d'Athens"): exported for tests. */
export function frenchTitle(name: string): string {
  const of: [RegExp, string][] = [
    [/^Grand Duchy of /i, 'grand-duché'], [/^Grand Principality of /i, 'grande-principauté'], [/^Kingdom of /i, 'royaume'],
    [/^Duchy of /i, 'duché'], [/^County of /i, 'comté'], [/^Principality of /i, 'principauté'], [/^Margraviate of /i, 'margraviat'],
    [/^Landgraviate of /i, 'landgraviat'], [/^Republic of /i, 'république'], [/^Empire of /i, 'empire'], [/^Sultanate of /i, 'sultanat'],
    [/^Emirate of /i, 'émirat'], [/^Khanate of /i, 'khanat'], [/^Caliphate of /i, 'califat'], [/^Lordship of /i, 'seigneurie'],
    [/^Archbishopric of /i, 'archevêché'], [/^Prince-Bishopric of /i, 'principauté épiscopale'], [/^Bishopric of /i, 'évêché'],
    [/^Despotate of /i, 'despotat'], [/^Electorate of /i, 'électorat'], [/^Viceroyalty of /i, 'vice-royauté'], [/^House of /i, 'maison'],
    [/^Banate of /i, 'banat'], [/^Tsardom of /i, 'tsarat'], [/^Duchies of /i, 'duchés'], [/^Principalities of /i, 'principautés'],
  ];
  for (const [re, fr] of of) {
    if (!re.test(name)) continue;
    const rest = name.replace(re, '').replace(/^the /i, '');
    return `${fr} ${/^[aeiouyàâéèêîïôûh]/i.test(rest) ? `d'${rest}` : `de ${rest}`}`;
  }
  // Only after proper names: "Swedish Empire" would give "empire Swedish".
  const suffix: [RegExp, string][] = [
    [/ Dynasty$/i, 'dynastie'], [/ Sultanate$/i, 'sultanat'], [/ Caliphate$/i, 'califat'],
    [/ Khanate$/i, 'khanat'], [/ Emirate$/i, 'émirat'], [/ City-States$/i, 'cités-États'], [/ Shogunate$/i, 'shogunat'],
  ];
  for (const [re, fr] of suffix) if (re.test(name)) return `${fr} ${name.replace(re, '')}`;
  return name;
}
