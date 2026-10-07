import { fetchJson } from './http.ts';
import { commonsThumb, parseYear, sparql } from './wikidata.ts';

// Kingdoms and empires of the border snapshots. The snapshots only carry an
// English name ("Rome", "Castille", "Achaemenid Empire"): candidates are
// searched by name, then scored by the caller with the facts below.

export interface PolityCandidate {
  qid: string;
  labelFr: string | null;
  labelEn: string | null;
  sitelinks: number;
  classes: string[];
  starts: number[];
  ends: number[];
  /** How many state-like properties it has (capital, head of state, government, currency...). */
  stateProps: number;
}

export interface DatedValue { label: string; start: number | null; end: number | null }

export interface PolityRuler {
  qid: string;
  name: string;
  office: string | null;
  start: number | null;
  end: number | null;
  image: string | null;
}

export interface PolityDetails {
  qid: string;
  labelFr: string | null;
  labelEn: string | null;
  description: string | null;
  kinds: string[];
  starts: number[];
  ends: number[];
  flag: string | null;
  coatOfArms: string | null;
  image: string | null;
  frTitle: string | null;
  enTitle: string | null;
  government: string[];
  religion: string[];
  languages: string[];
  capitals: DatedValue[];
  rulers: PolityRuler[];
}

interface WbSearch { search?: { id: string }[] }

/** Wikidata items whose label or alias in `lang` matches `name`. */
export async function searchIds(name: string, lang = 'en', limit = 7): Promise<string[]> {
  const s = await fetchJson<WbSearch>(
    `https://www.wikidata.org/w/api.php?${new URLSearchParams({
      action: 'wbsearchentities', search: name, language: lang, uselang: lang, type: 'item', limit: String(limit), format: 'json',
    })}`,
  );
  return (s.search ?? []).map((x) => x.id);
}

interface WikiSearch { query?: { pages?: Record<string, { index?: number; pageprops?: { wikibase_item?: string } }> } }

/** Items of the English Wikipedia articles found by full-text search (tolerates misspellings). */
export async function articleIds(text: string, limit = 5): Promise<string[]> {
  const s = await fetchJson<WikiSearch>(
    `https://en.wikipedia.org/w/api.php?${new URLSearchParams({
      action: 'query', generator: 'search', gsrsearch: text, gsrlimit: String(limit), prop: 'pageprops',
      ppprop: 'wikibase_item', format: 'json',
    })}`,
  );
  return Object.values(s.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => p.pageprops?.wikibase_item)
    .filter((q): q is string => !!q);
}

const qidOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const years = (v: string | undefined) =>
  (v ?? '').split('|').filter(Boolean).map(parseYear).filter((y): y is number => y !== null);
const list = (v: string | undefined) => (v ?? '').split('|').filter(Boolean);

/**
 * Facts to score candidates. One row per fact (UNION, no grouping): WDQS
 * answers this in well under a second, where a grouped query with the same
 * joins could time out, and the full entity JSON weighs megabytes.
 */
export async function candidateFacts(qids: string[]): Promise<PolityCandidate[]> {
  if (qids.length === 0) return [];
  const q = `
SELECT ?item ?sl ?k ?v WHERE {
  VALUES ?item { ${qids.slice(0, 40).map((x) => `wd:${x}`).join(' ')} }
  ?item wikibase:sitelinks ?sl .
  { ?item wdt:P31 ?v . BIND("class" AS ?k) }
  UNION { ?item wdt:P571|wdt:P580 ?v . BIND("start" AS ?k) }
  UNION { ?item wdt:P576|wdt:P582 ?v . BIND("end" AS ?k) }
  UNION { VALUES ?pp { wdt:P36 wdt:P35 wdt:P1906 wdt:P122 wdt:P38 } FILTER EXISTS { ?item ?pp [] } BIND(STR(?pp) AS ?v) BIND("state" AS ?k) }
  UNION { ?item rdfs:label ?v . FILTER(LANG(?v) = "fr" || LANG(?v) = "en") BIND(CONCAT("label-", LANG(?v)) AS ?k) }
}`;
  const byId = new Map<string, PolityCandidate>();
  for (const b of await sparql(q, 30_000)) {
    const qid = qidOf(b.item!.value);
    let c = byId.get(qid);
    if (!c) {
      c = { qid, labelFr: null, labelEn: null, sitelinks: Number(b.sl?.value ?? 0), classes: [], starts: [], ends: [], stateProps: 0 };
      byId.set(qid, c);
    }
    const v = b.v?.value ?? '';
    switch (b.k?.value) {
      case 'class': c.classes.push(qidOf(v)); break;
      case 'start': { const y = parseYear(v); if (y !== null) c.starts.push(y); break; }
      case 'end': { const y = parseYear(v); if (y !== null) c.ends.push(y); break; }
      case 'state': c.stateProps++; break;
      case 'label-fr': c.labelFr = v; break;
      case 'label-en': c.labelEn = v; break;
    }
  }
  return [...byId.values()];
}

/** Offices that make someone the ruler of a state (monarch, head of state, king, emperor, pharaoh). */
const RULER_OFFICES = 'wd:Q116 wd:Q48352 wd:Q12097 wd:Q39018 wd:Q37110';

export async function polityDetails(qid: string): Promise<PolityDetails | null> {
  const info = `
SELECT (SAMPLE(?lf) AS ?labelFr) (SAMPLE(?le) AS ?labelEn) (SAMPLE(?df) AS ?descFr) (SAMPLE(?de) AS ?descEn)
  (SAMPLE(?fl) AS ?flag) (SAMPLE(?co) AS ?coa) (SAMPLE(?im) AS ?img) (SAMPLE(?fr) AS ?frTitle) (SAMPLE(?en) AS ?enTitle)
  (GROUP_CONCAT(DISTINCT STR(?s); separator="|") AS ?starts) (GROUP_CONCAT(DISTINCT STR(?e); separator="|") AS ?ends)
  (GROUP_CONCAT(DISTINCT ?kindL; separator="|") AS ?kinds) (GROUP_CONCAT(DISTINCT ?govL; separator="|") AS ?govs)
  (GROUP_CONCAT(DISTINCT ?relL; separator="|") AS ?religions) (GROUP_CONCAT(DISTINCT ?langL; separator="|") AS ?langs)
WHERE {
  BIND(wd:${qid} AS ?item)
  OPTIONAL { ?item rdfs:label ?lf . FILTER(LANG(?lf) = "fr") }
  OPTIONAL { ?item rdfs:label ?le . FILTER(LANG(?le) = "en") }
  OPTIONAL { ?item schema:description ?df . FILTER(LANG(?df) = "fr") }
  OPTIONAL { ?item schema:description ?de . FILTER(LANG(?de) = "en") }
  OPTIONAL { ?item wdt:P41 ?fl }
  OPTIONAL { ?item wdt:P94 ?co }
  OPTIONAL { ?item wdt:P18 ?im }
  OPTIONAL { ?item wdt:P571|wdt:P580 ?s }
  OPTIONAL { ?item wdt:P576|wdt:P582 ?e }
  OPTIONAL { ?item wdt:P31 ?k . ?k rdfs:label ?kindL . FILTER(LANG(?kindL) = "fr") }
  OPTIONAL { ?item wdt:P122 ?g . ?g rdfs:label ?govL . FILTER(LANG(?govL) = "fr") }
  OPTIONAL { ?item wdt:P140 ?r . ?r rdfs:label ?relL . FILTER(LANG(?relL) = "fr") }
  OPTIONAL { ?item wdt:P37 ?l . ?l rdfs:label ?langL . FILTER(LANG(?langL) = "fr") }
  OPTIONAL { ?fa schema:about ?item ; schema:isPartOf <https://fr.wikipedia.org/> ; schema:name ?fr }
  OPTIONAL { ?ea schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en }
}`;
  const capitals = `
SELECT ?cap ?capLabel ?s ?e WHERE {
  wd:${qid} p:P36 ?st . ?st ps:P36 ?cap .
  OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
} LIMIT 100`;
  // Rulers: head-of-state statements, holders of the state's head-of-state
  // office (P1906), and holders of monarch-like offices for this jurisdiction.
  // Three simple queries: WDQS plans the combined UNION badly.
  const rulerQuery = (pattern: string) => `
SELECT ?person ?personLabel ?office ?officeLabel ?s ?e ?img WHERE {
  ${pattern}
  OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e }
  OPTIONAL { ?person wdt:P18 ?img }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
} LIMIT 1500`;
  const rulerPatterns = [
    `wd:${qid} p:P35 ?st . ?st ps:P35 ?person .`,
    `wd:${qid} wdt:P1906 ?office . ?person p:P39 ?st . ?st ps:P39 ?office .`,
    `?office wdt:P1001 wd:${qid} ; wdt:P279 ?sup . VALUES ?sup { ${RULER_OFFICES} } ?person p:P39 ?st . ?st ps:P39 ?office .`,
  ];
  const [i, c, ...rs] = await Promise.all([
    sparql(info, 30_000),
    sparql(capitals, 30_000),
    ...rulerPatterns.map((p) => sparql(rulerQuery(p), 30_000).catch(() => [])),
  ]);
  const r = rs.flat();
  const b = i[0];
  if (!b) return null;
  const seen = new Set<string>();
  const rulerRows: PolityRuler[] = [];
  for (const row of r) {
    const pid = qidOf(row.person!.value);
    const start = row.s?.value ? parseYear(row.s.value) : null;
    const key = `${pid}|${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = row.personLabel?.value ?? pid;
    rulerRows.push({
      qid: pid,
      name: /^Q\d+$/.test(name) ? pid : name,
      office: row.officeLabel?.value && !/^Q\d+$/.test(row.officeLabel.value) ? row.officeLabel.value : null,
      start,
      end: row.e?.value ? parseYear(row.e.value) : null,
      image: row.img?.value ? commonsThumb(row.img.value, 160) : null,
    });
  }
  return {
    qid,
    labelFr: b.labelFr?.value ?? null,
    labelEn: b.labelEn?.value ?? null,
    description: b.descFr?.value ?? b.descEn?.value ?? null,
    kinds: list(b.kinds?.value),
    starts: years(b.starts?.value),
    ends: years(b.ends?.value),
    flag: b.flag?.value ? commonsThumb(b.flag.value, 320) : null,
    coatOfArms: b.coa?.value ? commonsThumb(b.coa.value, 320) : null,
    image: b.img?.value ? commonsThumb(b.img.value, 800) : null,
    frTitle: b.frTitle?.value ?? null,
    enTitle: b.enTitle?.value ?? null,
    government: list(b.govs?.value),
    religion: list(b.religions?.value),
    languages: list(b.langs?.value),
    capitals: c
      .filter((row) => row.capLabel && !/^Q\d+$/.test(row.capLabel.value))
      .map((row) => ({
        label: row.capLabel!.value,
        start: row.s?.value ? parseYear(row.s.value) : null,
        end: row.e?.value ? parseYear(row.e.value) : null,
      })),
    rulers: rulerRows,
  };
}

export interface SubdivisionRow {
  qid: string;
  labelFr: string | null;
  labelEn: string | null;
  sitelinks: number;
  /** English labels of its classes. */
  classes: string[];
  lat: number | null;
  lon: number | null;
  /** Inception / dissolution, and the validity qualifiers of the link to the parent. */
  starts: number[];
  ends: number[];
  linkStarts: number[];
  linkEnds: number[];
  /** Items it is itself located in (to keep only the top level). */
  parents: string[];
}

const point = (w: string | undefined) => (w ? /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(w.trim()) : null);

/**
 * Regions of a territory, as Wikidata links them: located in it (P131),
 * listed as its subdivisions (P150), in it as a country (P17), or part of
 * it (P361). Four simple queries: their UNION times out on big states.
 */
export async function subdivisions(qid: string): Promise<SubdivisionRow[]> {
  const patterns = [
    `?sub p:P131 ?st . ?st ps:P131 wd:${qid} .`,
    `wd:${qid} p:P150 ?st . ?st ps:P150 ?sub .`,
    `?sub p:P17 ?st . ?st ps:P17 wd:${qid} .`,
    `?sub p:P361 ?st . ?st ps:P361 wd:${qid} .`,
  ];
  // One row per combination of optional facts: WDQS plans this shape well
  // (about 2 s), where a UNION of facts around a subquery takes a minute.
  const query = (pattern: string) => `
SELECT ?sub ?sl ?cl ?coord ?cap ?s ?e ?ls ?le ?up ?lf ?len WHERE {
  ${pattern}
  ?sub wikibase:sitelinks ?sl .
  OPTIONAL { ?st pq:P580 ?ls } OPTIONAL { ?st pq:P582 ?le }
  OPTIONAL { ?sub wdt:P31 ?c . ?c rdfs:label ?cl . FILTER(LANG(?cl) = "en") }
  OPTIONAL { ?sub wdt:P625 ?coord }
  OPTIONAL { ?sub wdt:P36/wdt:P625 ?cap }
  OPTIONAL { ?sub wdt:P571 ?s } OPTIONAL { ?sub wdt:P576 ?e }
  OPTIONAL { ?sub wdt:P131 ?up }
  OPTIONAL { ?sub rdfs:label ?lf . FILTER(LANG(?lf) = "fr") }
  OPTIONAL { ?sub rdfs:label ?len . FILTER(LANG(?len) = "en") }
} LIMIT 20000`;
  // A list that times out (the Ottoman Empire as a "country" of thousands of items) is left out.
  const results = await Promise.all(patterns.map((p) => sparql(query(p), 20_000).catch(() => null)));
  if (results.every((r) => r === null)) throw new Error(`subdivisions of ${qid}: every query failed`);
  const byId = new Map<string, SubdivisionRow & { capLat: number | null; capLon: number | null }>();
  const push = (arr: number[], v: string | undefined) => {
    const y = v ? parseYear(v) : null;
    if (y !== null && !arr.includes(y)) arr.push(y);
  };
  for (const b of results.flatMap((r) => r ?? [])) {
    const id = qidOf(b.sub!.value);
    let s = byId.get(id);
    if (!s) {
      s = {
        qid: id, labelFr: null, labelEn: null, sitelinks: Number(b.sl?.value ?? 0), classes: [], lat: null, lon: null,
        capLat: null, capLon: null, starts: [], ends: [], linkStarts: [], linkEnds: [], parents: [],
      };
      byId.set(id, s);
    }
    const cl = b.cl?.value;
    if (cl && !s.classes.includes(cl)) s.classes.push(cl);
    const m = point(b.coord?.value);
    if (m) { s.lon = Number(m[1]); s.lat = Number(m[2]); }
    const cm = point(b.cap?.value);
    if (cm) { s.capLon = Number(cm[1]); s.capLat = Number(cm[2]); }
    push(s.starts, b.s?.value);
    push(s.ends, b.e?.value);
    push(s.linkStarts, b.ls?.value);
    push(s.linkEnds, b.le?.value);
    const up = b.up?.value ? qidOf(b.up.value) : null;
    if (up && !s.parents.includes(up)) s.parents.push(up);
    if (b.lf?.value) s.labelFr = b.lf.value;
    if (b.len?.value) s.labelEn = b.len.value;
  }
  // Without coordinates of its own, a region is placed at its capital.
  return [...byId.values()].map(({ capLat, capLon, ...s }) =>
    s.lat === null && capLat !== null ? { ...s, lat: capLat, lon: capLon } : s,
  );
}

/** A coat of arms or flag, with the years it was used (from the statement's qualifiers). */
export interface DatedFile { file: string; start: number | null; end: number | null }
/** An item's coats of arms and flags, and the years the item itself existed. */
export interface ItemEmblems { coa: DatedFile[]; flag: DatedFile[]; start: number | null; end: number | null }

/** Commons file name of a Special:FilePath URL. */
export function commonsFile(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1)).replace(/_/g, ' ');
}

/** Bumped when emblem sources change: items found without any are looked up again. */
export const EMBLEMS_VERSION = 2;

/** Coats of arms (P94) and flags (P41) of items, deprecated ones left out, 50 per query. */
export async function itemEmblems(qids: string[]): Promise<Map<string, ItemEmblems>> {
  const out = new Map<string, ItemEmblems>();
  for (let i = 0; i < qids.length; i += 50) {
    const q = `
SELECT ?item ?kind ?file ?s ?e ?is ?ie WHERE {
  VALUES ?item { ${qids.slice(i, i + 50).map((x) => `wd:${x}`).join(' ')} }
  VALUES (?p ?ps ?kind) { (p:P94 ps:P94 "coa") (p:P41 ps:P41 "flag") }
  ?item ?p ?st . ?st ?ps ?file .
  FILTER NOT EXISTS { ?st wikibase:rank wikibase:DeprecatedRank }
  OPTIONAL { ?st pq:P580 ?s }
  OPTIONAL { ?st pq:P582 ?e }
  OPTIONAL { ?item wdt:P571 ?is }
  OPTIONAL { ?item wdt:P576 ?ie }
}`;
    for (const b of await sparql(q, 30_000)) {
      const id = qidOf(b.item!.value);
      const kind = b.kind?.value === 'coa' ? 'coa' : 'flag';
      const cur = out.get(id) ?? { coa: [], flag: [], start: null, end: null };
      // Earliest start, latest end: the whole life of the item.
      const is = b.is?.value ? parseYear(b.is.value) : null;
      const ie = b.ie?.value ? parseYear(b.ie.value) : null;
      if (is !== null && (cur.start === null || is < cur.start)) cur.start = is;
      if (ie !== null && (cur.end === null || ie > cur.end)) cur.end = ie;
      const file = commonsFile(b.file!.value);
      if (!cur[kind].some((x) => x.file === file)) {
        cur[kind].push({ file, start: b.s?.value ? parseYear(b.s.value) : null, end: b.e?.value ? parseYear(b.e.value) : null });
      }
      out.set(id, cur);
    }
  }
  const bare = qids.filter((q) => !out.get(q)?.coa.length && !out.get(q)?.flag.length);
  if (bare.length) await emblemFallbacks(bare, out);
  return out;
}

/**
 * For items without an emblem of their own: the image of their "coat of
 * arms" item (P237) or "flag" item (P163), else their seal (P158). Undated:
 * they only show within the item's lifetime.
 */
async function emblemFallbacks(qids: string[], out: Map<string, ItemEmblems>): Promise<void> {
  for (let i = 0; i < qids.length; i += 50) {
    const q = `
SELECT ?item ?kind ?file ?is ?ie WHERE {
  VALUES ?item { ${qids.slice(i, i + 50).map((x) => `wd:${x}`).join(' ')} }
  { ?item wdt:P237 ?x . ?x wdt:P18|wdt:P94 ?file . BIND("coa" AS ?kind) }
  UNION { ?item wdt:P163 ?x . ?x wdt:P18|wdt:P41 ?file . BIND("flag" AS ?kind) }
  UNION { ?item wdt:P158 ?file . BIND("coa" AS ?kind) }
  OPTIONAL { ?item wdt:P571 ?is }
  OPTIONAL { ?item wdt:P576 ?ie }
}`;
    for (const b of await sparql(q, 30_000)) {
      const id = qidOf(b.item!.value);
      const kind = b.kind?.value === 'coa' ? 'coa' : 'flag';
      const cur = out.get(id) ?? { coa: [], flag: [], start: null, end: null };
      const is = b.is?.value ? parseYear(b.is.value) : null;
      const ie = b.ie?.value ? parseYear(b.ie.value) : null;
      if (is !== null && (cur.start === null || is < cur.start)) cur.start = is;
      if (ie !== null && (cur.end === null || ie > cur.end)) cur.end = ie;
      const file = commonsFile(b.file!.value);
      if (!cur[kind].some((x) => x.file === file)) cur[kind].push({ file, start: null, end: null });
      out.set(id, cur);
    }
  }
}

export interface ItemLabel { fr: string | null; en: string | null; start: number | null; end: number | null }

/**
 * French and English labels of items, with their start and end years (to
 * catch an item that belongs to another era), 50 per query.
 */
export async function itemLabels(qids: string[]): Promise<Map<string, ItemLabel>> {
  const out = new Map<string, ItemLabel>();
  for (let i = 0; i < qids.length; i += 50) {
    const q = `
SELECT ?item ?lf ?le ?s ?e WHERE {
  VALUES ?item { ${qids.slice(i, i + 50).map((x) => `wd:${x}`).join(' ')} }
  OPTIONAL { ?item rdfs:label ?lf . FILTER(LANG(?lf) = "fr") }
  OPTIONAL { ?item rdfs:label ?le . FILTER(LANG(?le) = "en") }
  OPTIONAL { ?item wdt:P571|wdt:P580 ?s }
  OPTIONAL { ?item wdt:P576|wdt:P582 ?e }
}`;
    for (const b of await sparql(q, 30_000)) {
      const id = qidOf(b.item!.value);
      const cur = out.get(id) ?? { fr: null, en: null, start: null, end: null };
      const st = b.s?.value ? parseYear(b.s.value) : null;
      const en = b.e?.value ? parseYear(b.e.value) : null;
      out.set(id, {
        fr: b.lf?.value ?? cur.fr,
        en: b.le?.value ?? cur.en,
        start: st !== null && (cur.start === null || st < cur.start) ? st : cur.start,
        end: en !== null && (cur.end === null || en > cur.end) ? en : cur.end,
      });
    }
  }
  return out;
}

/** A realm's religion statement (P140 religion, P3075 official religion), with its years. */
export interface DatedFaith {
  faith: string;
  start: number | null;
  end: number | null;
  /** How much the statement counts: preferred rank and official religion weigh more. */
  weight: number;
  /**
   * Said of a kin of the realm (what it followed or was followed by, what it
   * was part of): counted only when the realm itself says nothing.
   */
  kin?: boolean;
  /** For a people's or language's statement: where it comes from (its people first, then its official language, then those used). */
  how?: 'people' | 'official' | 'used';
  /** A learned language (Latin, Classical Chinese): it never speaks for a realm that states a language of its own. */
  learned?: boolean;
}

/** A realm's kin, whose religion or language it likely shared: predecessor, successor, the realm it was part of. */
const KIN = 'wdt:P155|wdt:P156|wdt:P1365|wdt:P1366|wdt:P361';

/** What the kin of realms state (best rank only, undated): `path` the property asked, 50 realms per query. */
async function kinRows(qids: string[], path: string): Promise<{ item: string; value: string }[]> {
  const out: { item: string; value: string }[] = [];
  for (let i = 0; i < qids.length; i += 50) {
    const q = `
SELECT DISTINCT ?item ?v WHERE {
  VALUES ?item { ${qids.slice(i, i + 50).map((x) => `wd:${x}`).join(' ')} }
  ?item ${KIN} ?k . ?k ${path} ?v .
}`;
    for (const b of await sparql(q, 30_000)) {
      if (b.v?.value.includes('/entity/Q')) out.push({ item: qidOf(b.item!.value), value: qidOf(b.v.value) });
    }
  }
  return out;
}

/** Root religions, by family key: a statement matches the root it descends from. */
const FAITH_ROOTS: [string, string[]][] = [
  ['christianity', ['Q5043']],
  ['islam', ['Q432']],
  ['judaism', ['Q9268']],
  ['zoroastrianism', ['Q9601']],
  // The Vedic religion is counted with its heir.
  ['hinduism', ['Q9089', 'Q194497']],
  ['buddhism', ['Q748']],
  ['jainism', ['Q9232']],
  ['sikhism', ['Q9316']],
  ['chinese', ['Q9581', 'Q9598', 'Q1074275', 'Q5694834']],
  ['shinto', ['Q812767']],
  // Polytheisms of antiquity and traditional religions (Greek, Roman, Etruscan, Scythian, Thracian…).
  ['ancient', ['Q29536', 'Q9134', 'Q855270', 'Q337547', 'Q478186', 'Q12153518', 'Q4492323']],
];

/** Bumped when FAITH_ROOTS or the lookup change: cached answers are then looked up again. */
export const FAITHS_VERSION = 5;

/** Religion item -> family, for the life of the process (a few hundred at most). */
const faithFamilies = new Map<string, string>();

/** Family of each religion item: itself or what it is part of / follows, up its subclasses. */
async function faithFamiliesOf(rels: string[]): Promise<void> {
  const roots = new Map<string, string>();
  for (const [family, ids] of FAITH_ROOTS) for (const id of ids) roots.set(id, family);
  const missing = rels.filter((r) => !faithFamilies.has(r));
  for (let i = 0; i < missing.length; i += 60) {
    const chunk = missing.slice(i, i + 60);
    const q = `
SELECT ?rel ?root WHERE {
  VALUES ?rel { ${chunk.map((x) => `wd:${x}`).join(' ')} }
  VALUES ?root { ${[...roots.keys()].map((r) => `wd:${r}`).join(' ')} }
  { ?rel wdt:P279* ?root } UNION { ?rel wdt:P140|wdt:P361 ?x . ?x wdt:P279* ?root }
}`;
    // A religion under several roots takes the first family listed (Zoroastrianism is not "ancient").
    const rank = (f: string) => FAITH_ROOTS.findIndex(([x]) => x === f);
    const found = new Map<string, string>();
    for (const b of await sparql(q, 30_000)) {
      const rel = qidOf(b.rel!.value);
      const family = roots.get(qidOf(b.root!.value))!;
      const cur = found.get(rel);
      if (cur === undefined || rank(family) < rank(cur)) found.set(rel, family);
    }
    for (const r of chunk) faithFamilies.set(r, found.get(r) ?? 'other');
  }
}

/**
 * Religions of realms (their family: christianity, islam…), deprecated
 * statements left out, 50 per query; with those of their kin (`kin`), for
 * the realms that state none. A religion with no known family counts as
 * `other`. "Christianity" stated beside "Catholicism" in the same property
 * says it once, not twice (the Hafsids list Islam, Catholicism, Christianity
 * and Judaism as official: the Christian minority must not outweigh Islam).
 */
export async function itemFaiths(qids: string[]): Promise<Map<string, DatedFaith[]>> {
  const rows: { item: string; rel: string; start: number | null; end: number | null; weight: number; kin: boolean; official?: boolean }[] = [];
  for (let i = 0; i < qids.length; i += 50) {
    const q = `
SELECT ?item ?rel ?s ?e ?official ?rank WHERE {
  VALUES ?item { ${qids.slice(i, i + 50).map((x) => `wd:${x}`).join(' ')} }
  VALUES (?p ?ps ?official) { (p:P140 ps:P140 false) (p:P3075 ps:P3075 true) }
  ?item ?p ?st . ?st ?ps ?rel ; wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  OPTIONAL { ?st pq:P580 ?s }
  OPTIONAL { ?st pq:P582 ?e }
}`;
    for (const b of await sparql(q, 30_000)) {
      if (!b.rel?.value.includes('/entity/Q')) continue;
      rows.push({
        item: qidOf(b.item!.value), rel: qidOf(b.rel.value),
        start: b.s?.value ? parseYear(b.s.value) : null, end: b.e?.value ? parseYear(b.e.value) : null,
        weight: (b.official?.value === 'true' ? 2 : 1) * (b.rank?.value.endsWith('PreferredRank') ? 3 : 1),
        kin: false, official: b.official?.value === 'true',
      });
    }
  }
  // The realms that state none: their kin's (a query of its own, WDQS plans the UNION badly).
  const silent = qids.filter((x) => !rows.some((r) => r.item === x));
  for (const r of await kinRows(silent, 'wdt:P140|wdt:P3075')) rows.push({ item: r.item, rel: r.value, start: null, end: null, weight: 1, kin: true });
  await faithFamiliesOf([...new Set(rows.map((r) => r.rel))]);
  const roots = new Set(FAITH_ROOTS.flatMap(([, ids]) => ids));
  const family = (rel: string) => faithFamilies.get(rel) ?? 'other';
  const generic = (r: (typeof rows)[number]) => roots.has(r.rel) && rows.some((o) =>
    o !== r && o.item === r.item && o.kin === r.kin && o.official === r.official && o.rel !== r.rel && family(o.rel) === family(r.rel));
  const out = new Map<string, DatedFaith[]>();
  for (const row of rows) {
    if (generic(row)) continue;
    const { item, rel, kin, official: _, ...r } = row;
    (out.get(item) ?? out.set(item, []).get(item)!).push({ faith: family(rel), ...r, ...(kin ? { kin } : {}) });
  }
  return out;
}

/**
 * Root languages of each ethnolinguistic family (ids checked against
 * Wikidata): a language falls in the family of the first root it descends from.
 */
const CULTURE_ROOTS: [string, string[]][] = [
  // Latin and the Romance languages (Latino-Faliscan holds Latin itself).
  ['latin', ['Q19814', 'Q33478', 'Q397']],
  ['germanic', ['Q21200']],
  ['slavic', ['Q23526', 'Q33251', 'Q35499']],
  ['celtic', ['Q25293']],
  ['hellenic', ['Q2042538', 'Q9129', 'Q35497', 'Q107358']],
  ['baltic', ['Q33136']],
  ['iranian', ['Q33527']],
  ['indic', ['Q33577', 'Q11059']],
  ['semitic', ['Q34049', 'Q35518', 'Q28602']],
  ['afroasiatic', ['Q50868', 'Q34610803', 'Q25448', 'Q33248']],
  ['turkic', ['Q34090']],
  ['mongolic', ['Q33750', 'Q34230']],
  ['uralic', ['Q34113']],
  ['caucasian', ['Q34030', 'Q8785']],
  ['sinitic', ['Q33857', 'Q7850', 'Q37041']],
  ['tibetoburman', ['Q34064']],
  ['japonic', ['Q33612', 'Q11263525', 'Q9176']],
  ['seasian', ['Q34171', 'Q33199']],
  ['austronesian', ['Q49228']],
  ['dravidian', ['Q33311']],
  ['african', ['Q33838', 'Q33146', 'Q33705']],
  ['american', ['Q5218', 'Q34073', 'Q33738']],
];

/**
 * Learned languages a court wrote in without speaking them (Latin in
 * Hungary or Poland, Classical Chinese in Japan, Church Slavonic in
 * Wallachia): they count little next to the realm's own.
 */
const LEARNED = new Set(['Q397', 'Q1163234', 'Q37041', 'Q33251', 'Q35499']);

/** Bumped when CULTURE_ROOTS or the lookup change: cached answers are then looked up again. */
export const CULTURES_VERSION = 2;

/** Language item -> family, for the life of the process. */
const cultureFamilies = new Map<string, string>();

async function cultureFamiliesOf(langs: string[]): Promise<void> {
  const roots = new Map<string, string>();
  for (const [family, ids] of CULTURE_ROOTS) for (const id of ids) roots.set(id, family);
  const missing = langs.filter((r) => !cultureFamilies.has(r));
  const rank = (f: string) => CULTURE_ROOTS.findIndex(([x]) => x === f);
  for (let i = 0; i < missing.length; i += 60) {
    const chunk = missing.slice(i, i + 60);
    const q = `
SELECT ?lang ?root WHERE {
  VALUES ?lang { ${chunk.map((x) => `wd:${x}`).join(' ')} }
  VALUES ?root { ${[...roots.keys()].map((r) => `wd:${r}`).join(' ')} }
  { ?lang wdt:P279* ?root } UNION { ?lang wdt:P361 ?x . ?x wdt:P279* ?root }
}`;
    const found = new Map<string, string>();
    for (const b of await sparql(q, 30_000)) {
      const lang = qidOf(b.lang!.value);
      const family = roots.get(qidOf(b.root!.value))!;
      const cur = found.get(lang);
      if (cur === undefined || rank(family) < rank(cur)) found.set(lang, family);
    }
    for (const r of chunk) cultureFamilies.set(r, found.get(r) ?? 'other');
  }
}

/**
 * The peoples and languages of realms, as families (latin, germanic,
 * turkic…): the ethnic group Wikidata gives (through its language) weighs
 * most, then the official language, then the languages used; learned
 * languages count little; those of their kin (`kin`) for the realms that
 * state none. Reuses `DatedFaith` (its `faith` is the family).
 */
export async function itemCultures(qids: string[]): Promise<Map<string, DatedFaith[]>> {
  const rows: { item: string; lang: string; start: number | null; end: number | null; weight: number; kin: boolean; how: 'people' | 'official' | 'used' }[] = [];
  const weigh = (lang: string, how: number, preferred: boolean) => how * (preferred ? 3 : 1) * (LEARNED.has(lang) ? 0.2 : 1);
  for (let i = 0; i < qids.length; i += 50) {
    const items = qids.slice(i, i + 50).map((x) => `wd:${x}`).join(' ');
    // Languages, dated; then peoples, through their language: two queries, WDQS plans their UNION badly.
    const languages = `
SELECT ?item ?lang ?s ?e ?official ?rank WHERE {
  VALUES ?item { ${items} }
  VALUES (?p ?ps ?official) { (p:P37 ps:P37 true) (p:P2936 ps:P2936 false) }
  ?item ?p ?st . ?st ?ps ?lang ; wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  OPTIONAL { ?st pq:P580 ?s }
  OPTIONAL { ?st pq:P582 ?e }
}`;
    for (const b of await sparql(languages, 30_000)) {
      if (!b.lang?.value.includes('/entity/Q')) continue;
      const lang = qidOf(b.lang.value);
      rows.push({
        item: qidOf(b.item!.value), lang,
        start: b.s?.value ? parseYear(b.s.value) : null, end: b.e?.value ? parseYear(b.e.value) : null,
        weight: weigh(lang, b.official?.value === 'true' ? 2 : 1, !!b.rank?.value.endsWith('PreferredRank')), kin: false,
        how: b.official?.value === 'true' ? 'official' : 'used',
      });
    }
    const peoples = `
SELECT ?item ?lang WHERE {
  VALUES ?item { ${items} }
  ?item wdt:P172 ?people . ?people wdt:P103|wdt:P2936 ?lang .
}`;
    for (const b of await sparql(peoples, 30_000)) {
      if (!b.lang?.value.includes('/entity/Q')) continue;
      const lang = qidOf(b.lang.value);
      rows.push({ item: qidOf(b.item!.value), lang, start: null, end: null, weight: weigh(lang, 3, false), kin: false, how: 'people' });
    }
  }
  const silent = qids.filter((x) => !rows.some((r) => r.item === x));
  for (const r of await kinRows(silent, 'wdt:P37')) rows.push({ item: r.item, lang: r.value, start: null, end: null, weight: weigh(r.value, 1, false), kin: true, how: 'official' });
  await cultureFamiliesOf([...new Set(rows.map((r) => r.lang))]);
  const out = new Map<string, DatedFaith[]>();
  for (const { item, lang, kin, ...r } of rows) {
    const learned = LEARNED.has(lang);
    (out.get(item) ?? out.set(item, []).get(item)!).push({ faith: cultureFamilies.get(lang) ?? 'other', ...r, ...(kin ? { kin } : {}), ...(learned ? { learned } : {}) });
  }
  return out;
}
