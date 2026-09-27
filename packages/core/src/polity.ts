import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { coolingUntil, polity, wikipedia, type PolityCandidate, type PolityDetails } from '@way/providers';
import type { PolityInfo, PolityLabels, PolityRulerInfo } from '@way/shared';
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
/** Pause between background lookups: map names are a nicety, Wikimedia's patience is not. */
const BACKGROUND_GAP_MS = 1500;
const HOSTS = ['www.wikidata.org', 'query.wikidata.org', 'en.wikipedia.org', 'fr.wikipedia.org'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Resolution { qid: string | null; score: number; labelFr: string | null; labelEn?: string | null }
interface CachedDetails extends PolityDetails {
  summary: { text: string; lang: string; url: string; title: string } | null;
}
interface CacheFile { resolutions: Record<string, Resolution>; details: Record<string, CachedDetails> }

const range = (xs: number[], pick: (...v: number[]) => number) => (xs.length ? pick(...xs) : null);

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
  private cache: CacheFile = { resolutions: {}, details: {} };
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
        this.cache = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
      } catch {
        /* corrupt cache: rebuilt on demand */
      }
    }
  }

  /** Card for a territory clicked at `year`. */
  async info(name: string, year: number): Promise<PolityInfo> {
    this.interactive++;
    try {
      return await this.build(name, year);
    } finally {
      this.interactive--;
    }
  }

  private async build(name: string, year: number): Promise<PolityInfo> {
    const res = await this.resolve(name, year);
    const d = res?.qid ? await this.details(res.qid) : null;
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
      if (r) {
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
    void this.work();
  }

  /** One lookup at a time: labels are a nicety, Wikidata's time is shared. */
  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    while (this.queue.length) {
      // Yield to someone clicking a territory, and wait when Wikimedia asked us to.
      const cool = Math.max(...HOSTS.map(coolingUntil)) - Date.now();
      if (cool > 0) await sleep(cool + 2000);
      while (this.interactive > 0) await sleep(500);
      const job = this.queue.shift()!;
      await this.resolve(job.name, job.year).catch(() => null);
      this.queued.delete(key(job.name, job.year));
      await sleep(BACKGROUND_GAP_MS);
    }
    this.working = false;
  }

  private resolve(name: string, year: number): Promise<Resolution | null> {
    const k = key(name, year);
    const hit = this.cache.resolutions[k];
    if (hit) return Promise.resolve(hit);
    let p = this.inflight.get(k);
    if (!p) {
      p = this.lookup(name, year)
        .then((r) => {
          this.cache.resolutions[k] = r;
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
    if (best.s < CONFIDENT) {
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
    if (hit) return hit;
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
    const out = { ...d, summary };
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
