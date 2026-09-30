import { fetchJson } from './http.ts';

const SPARQL_URL = 'https://query.wikidata.org/sparql';

/** Date properties that anchor an entity in time, by preference order. */
export const DATE_PROPS = ['P585', 'P580', 'P571'] as const; // point in time, start time, inception
export type DateProp = (typeof DATE_PROPS)[number];

export interface DatedRow {
  qid: string;
  lat: number;
  lon: number;
  year: number; // historical year
  precision: number; // Wikidata time precision (9 = year, 7 = century...)
  prop: DateProp;
  sitelinks: number;
}

export interface EntityInfo {
  qid: string;
  label: string | null;
  labelLang: string | null;
  description: string | null;
  classes: string[];
  image: string | null;
  frTitle: string | null;
  enTitle: string | null;
  endYear: number | null;
}

interface SparqlResponse {
  results: { bindings: Record<string, { type: string; value: string; datatype?: string }>[] };
}

export async function sparql(query: string, timeoutMs = 65_000): Promise<SparqlResponse['results']['bindings']> {
  const started = Date.now();
  try {
    const res = await fetchJson<SparqlResponse>(SPARQL_URL, {
      method: 'POST',
      body: new URLSearchParams({ query }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      timeoutMs,
      retries: 1,
    });
    return res.results.bindings;
  } finally {
    const ms = Date.now() - started;
    if (ms > 8000) console.warn(`[wdqs] slow query (${ms} ms): ${query.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  }
}

// ---------- helpers ----------

/** Historical year -> xsd:dateTime literal in WDQS (astronomical) numbering. */
export function yearLiteral(histYear: number): string {
  const a = histYear < 0 ? histYear + 1 : histYear;
  const sign = a < 0 ? '-' : '';
  return `"${sign}${String(Math.abs(a)).padStart(4, '0')}-01-01T00:00:00Z"^^xsd:dateTime`;
}

/** Parse a WDQS dateTime ("-0752-04-13T00:00:00Z") into a historical year. */
export function parseYear(value: string): number | null {
  const m = /^(-?)(\d+)-/.exec(value);
  if (!m) return null;
  const a = Number(m[2]) * (m[1] ? -1 : 1);
  return a <= 0 ? a - 1 : a;
}

/** Parse "Point(lon lat)"; rejects coordinates on other globes. */
export function parsePoint(wkt: string): { lat: number; lon: number } | null {
  const m = /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const qidOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

const DATE_VALUES = DATE_PROPS.map((p) => `(p:${p} psv:${p} "${p}")`).join(' ');

function datedBlock(t0: number, t1Excl: number): string {
  return `
  ?item ?pp ?st .
  VALUES (?pp ?psv ?kind) { ${DATE_VALUES} }
  ?st ?psv ?vn .
  ?vn wikibase:timeValue ?t ; wikibase:timePrecision ?prec .
  FILTER(?t >= ${yearLiteral(t0)} && ?t < ${yearLiteral(t1Excl)})`;
}

function rowsToDated(bindings: SparqlResponse['results']['bindings']): DatedRow[] {
  // Keep one row per item: preferred date property, then first coordinate.
  const best = new Map<string, DatedRow>();
  for (const b of bindings) {
    const pt = b.coord && parsePoint(b.coord.value);
    const year = b.t && parseYear(b.t.value);
    if (!pt || year == null || !b.item || !b.kind) continue;
    const row: DatedRow = {
      qid: qidOf(b.item.value),
      ...pt,
      year,
      precision: Number(b.prec?.value ?? 9),
      prop: b.kind.value as DateProp,
      sitelinks: Number(b.sl?.value ?? 0),
    };
    const prev = best.get(row.qid);
    if (!prev || DATE_PROPS.indexOf(row.prop) < DATE_PROPS.indexOf(prev.prop)) best.set(row.qid, row);
  }
  return [...best.values()];
}

// ---------- queries ----------

/**
 * Time-first global query: notable dated entities with coordinates anywhere
 * on Earth. Used for globe/continent views (one query serves every cell).
 */
export async function queryGlobal(t0: number, t1Excl: number, minSitelinks: number, limit: number): Promise<DatedRow[]> {
  const q = `
SELECT ?item ?coord ?t ?prec ?kind ?sl WHERE {
  ${datedBlock(t0, t1Excl)}
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= ${minSitelinks})
  ?item wdt:P625 ?coord .
} ORDER BY DESC(?sl) LIMIT ${limit}`;
  return rowsToDated(await sparql(q));
}

/** Space-first query: dated entities around a point (fine views). */
export async function queryAround(
  lat: number, lon: number, radiusKm: number, t0: number, t1Excl: number, limit: number,
): Promise<DatedRow[]> {
  const q = `
SELECT ?item ?coord ?t ?prec ?kind ?sl WITH {
  SELECT ?item ?coord WHERE {
    SERVICE wikibase:around {
      ?item wdt:P625 ?coord .
      bd:serviceParam wikibase:center "Point(${lon.toFixed(5)} ${lat.toFixed(5)})"^^geo:wktLiteral .
      bd:serviceParam wikibase:radius "${radiusKm.toFixed(2)}" .
    }
  }
} AS %geo WHERE {
  INCLUDE %geo
  ${datedBlock(t0, t1Excl)}
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= 1)
} ORDER BY DESC(?sl) LIMIT ${limit}`;
  return rowsToDated(await sparql(q));
}

/** Dates and coordinates for known items (e.g. Wikipedia GeoSearch hits). */
export async function queryDatedByQids(qids: string[], t0: number, t1Excl: number): Promise<DatedRow[]> {
  if (qids.length === 0) return [];
  const q = `
SELECT ?item ?coord ?t ?prec ?kind ?sl WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} }
  ?item wdt:P625 ?coord .
  ${datedBlock(t0, t1Excl)}
  ?item wikibase:sitelinks ?sl .
}`;
  return rowsToDated(await sparql(q));
}

/** Labels, description, classes, image, article titles and end date. */
export async function queryEntityInfo(qids: string[]): Promise<Map<string, EntityInfo>> {
  const out = new Map<string, EntityInfo>();
  const chunks: string[][] = [];
  for (let i = 0; i < qids.length; i += 120) chunks.push(qids.slice(i, i + 120));
  // Chunks run concurrently; the per-host limiter keeps WDQS load polite.
  await Promise.all(chunks.map(async (chunk) => {
    const q = `
SELECT ?item (SAMPLE(?lf) AS ?labelFr) (SAMPLE(?le) AS ?labelEn) (SAMPLE(?df) AS ?descFr)
       (SAMPLE(?img) AS ?image) (SAMPLE(?fr) AS ?frTitle) (SAMPLE(?en) AS ?enTitle)
       (MAX(?e) AS ?end) (GROUP_CONCAT(DISTINCT STRAFTER(STR(?c), "entity/"); separator=" ") AS ?classes)
WHERE {
  VALUES ?item { ${chunk.map((q) => `wd:${q}`).join(' ')} }
  OPTIONAL { ?item rdfs:label ?lf . FILTER(LANG(?lf) = "fr") }
  OPTIONAL { ?item rdfs:label ?le . FILTER(LANG(?le) = "en") }
  OPTIONAL { ?item schema:description ?df . FILTER(LANG(?df) = "fr") }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P31 ?c }
  OPTIONAL { ?item wdt:P582|wdt:P576 ?e }
  OPTIONAL { ?fa schema:about ?item ; schema:isPartOf <https://fr.wikipedia.org/> ; schema:name ?fr }
  OPTIONAL { ?ea schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en }
} GROUP BY ?item`;
    for (const b of await sparql(q)) {
      const qid = qidOf(b.item!.value);
      const labelFr = b.labelFr?.value ?? null;
      out.set(qid, {
        qid,
        label: labelFr ?? b.labelEn?.value ?? null,
        labelLang: labelFr ? 'fr' : b.labelEn ? 'en' : null,
        description: b.descFr?.value ?? null,
        classes: (b.classes?.value ?? '').split(' ').filter(Boolean),
        image: b.image?.value ? commonsThumb(b.image.value) : null,
        frTitle: b.frTitle?.value ?? null,
        enTitle: b.enTitle?.value ?? null,
        endYear: b.end?.value ? parseYear(b.end.value) : null,
      });
    }
  }));
  return out;
}

/** Commons Special:FilePath URL, resized (the image is never stored). */
export function commonsThumb(filePathUrl: string, width = 800): string {
  const url = filePathUrl.replace(/^http:/, 'https:');
  return `${url}?width=${width}`;
}

// ---------- doors ----------

export type Relation = 'next' | 'effect' | 'cause' | 'prev' | 'partof' | 'part' | 'event' | 'person' | 'sibling';

export interface RelatedRow extends DatedRow {
  rel: Relation;
  /** Shared protagonist (person) or shared whole (sibling), in French. */
  via: string | null;
}

const REL_PRIORITY: Relation[] = ['next', 'effect', 'sibling', 'person', 'event', 'partof', 'part', 'prev', 'cause'];

// "source ?p item" and "item ?p source" statements, and what they mean for the source.
const OUT_RELS = '(wdt:P156 "next") (wdt:P1542 "effect") (wdt:P1536 "effect") (wdt:P155 "prev") (wdt:P828 "cause") (wdt:P361 "partof") (wdt:P793 "event") (wdt:P1344 "event")';
const IN_RELS = '(wdt:P155 "next") (wdt:P828 "effect") (wdt:P156 "prev") (wdt:P1542 "cause") (wdt:P1536 "cause") (wdt:P361 "part")';
// People attached to an event or place (participant, founder, creator, architect, namesake)...
const PERSON_OF = 'wdt:P710|wdt:P112|wdt:P170|wdt:P84|wdt:P61|wdt:P138';
// ...and how other dated places relate to the same person.
const OF_PERSON = 'wdt:P710|wdt:P112|wdt:P170|wdt:P84|wdt:P61';

/**
 * Dated, located entities linked to `qid`: what follows or results from it,
 * what caused it, what it belongs to, other parts of the same whole (the
 * next battle of a war) and events sharing a protagonist.
 */
export async function queryRelated(qid: string): Promise<RelatedRow[]> {
  const q = `
SELECT ?item ?coord ?t ?prec ?kind ?sl ?rel ?viaLabel WITH {
  SELECT DISTINCT ?item ?rel ?viaLabel WHERE {
    { VALUES (?p ?rel) { ${OUT_RELS} } wd:${qid} ?p ?item . }
    UNION
    { VALUES (?p ?rel) { ${IN_RELS} } ?item ?p wd:${qid} . }
    UNION
    {
      { wd:${qid} ${PERSON_OF} ?via } UNION { ?via wdt:P1344|wdt:P793 wd:${qid} }
      ?via wdt:P31 wd:Q5 .
      { ?item ${OF_PERSON} ?via } UNION { ?via wdt:P1344|wdt:P793 ?item }
      OPTIONAL { ?via rdfs:label ?viaLabel . FILTER(LANG(?viaLabel) = "fr") }
      BIND("person" AS ?rel)
    }
    UNION
    {
      # Wars, revolutions and campaigns rarely have coordinates; their parts do.
      wd:${qid} wdt:P361|wdt:P607 ?via .
      ?item wdt:P361|wdt:P607 ?via .
      OPTIONAL { ?via rdfs:label ?viaLabel . FILTER(LANG(?viaLabel) = "fr") }
      BIND("sibling" AS ?rel)
    }
    FILTER(?item != wd:${qid})
  } LIMIT 500
} AS %rel WHERE {
  INCLUDE %rel
  ?item wdt:P625 ?coord .
  ${datedBlock(-5000, new Date().getFullYear() + 1)}
  ?item wikibase:sitelinks ?sl .
}`;
  const bindings = await sparql(q);
  // rowsToDated keeps one row per item; attach the strongest relation found for it.
  const dated = new Map(rowsToDated(bindings).map((r) => [r.qid, r]));
  const out = new Map<string, RelatedRow>();
  for (const b of bindings) {
    const row = b.item && dated.get(qidOf(b.item.value));
    const rel = b.rel?.value as Relation | undefined;
    if (!row || !rel || !REL_PRIORITY.includes(rel)) continue;
    const prev = out.get(row.qid);
    if (!prev || REL_PRIORITY.indexOf(rel) < REL_PRIORITY.indexOf(prev.rel)) {
      out.set(row.qid, { ...row, rel, via: rel === 'person' || rel === 'sibling' ? (b.viaLabel?.value ?? null) : null });
    }
  }
  return [...out.values()];
}

export const relationRank = (r: Relation) => REL_PRIORITY.indexOf(r);

interface WbSearch { search?: { id: string }[] }

/** Items whose label or alias matches `name`, best match first. */
export async function searchItems(name: string, lang = 'fr', limit = 5): Promise<string[]> {
  const params = new URLSearchParams({ action: 'wbsearchentities', search: name, language: lang, uselang: lang, type: 'item', limit: String(limit), format: 'json' });
  const r = await fetchJson<WbSearch>(`https://www.wikidata.org/w/api.php?${params}`);
  return (r.search ?? []).map((x) => x.id);
}
