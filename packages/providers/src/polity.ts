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
  return out;
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
