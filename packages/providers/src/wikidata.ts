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
  const res = await fetchJson<SparqlResponse>(SPARQL_URL, {
    method: 'POST',
    body: new URLSearchParams({ query }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
    timeoutMs,
    retries: 1,
  });
  return res.results.bindings;
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
