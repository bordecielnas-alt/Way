import type { ActivityKind, Army, ArmyBattle, JourneyStop, PersonHit, PersonJourney } from '@way/shared';
import { dateToDecimal } from '@way/shared';
import { fetchJson } from './http.ts';
import { commonsThumb, parseYear, sparql, yearLiteral } from './wikidata.ts';

// Lives and campaigns, as Wikidata dates and places them: where someone was
// born, studied, lived, reigned, fought and died; which battles a side of a
// war fought, in order.

const qidOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const point = (w: string | undefined) => {
  const m = w ? /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(w.trim()) : null;
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
};
const isLabel = (v: string | undefined) => !!v && !/^Q\d+$/.test(v);

/** WDQS dateTime → decimal historical year ("1805-12-02" ≈ 1805.92). */
export function decimalYear(value: string | undefined): number | null {
  if (!value) return null;
  const y = parseYear(value);
  const m = /^-?\d+-(\d\d)-(\d\d)/.exec(value);
  if (y === null) return null;
  // Day of the year (precision "year" comes as 1 January).
  return dateToDecimal(y, m ? Number(m[1]) : 1, m ? Number(m[2]) : 1);
}

interface WikiSearch { query?: { search?: { title: string }[] } }

/** People whose name matches, best known first. */
export async function searchPeople(text: string): Promise<PersonHit[]> {
  const s = await fetchJson<WikiSearch>(
    `https://www.wikidata.org/w/api.php?${new URLSearchParams({
      action: 'query', list: 'search', srsearch: `haswbstatement:P31=Q5 ${text}`, srlimit: '10', srnamespace: '0', format: 'json',
    })}`,
  );
  const ids = (s.query?.search ?? []).map((r) => r.title).filter((t) => /^Q\d+$/.test(t));
  return peopleByQids(ids);
}

/** Humans among `ids` (other items are dropped), best known first. */
export async function peopleByQids(ids: string[]): Promise<PersonHit[]> {
  if (!ids.length) return [];
  const q = `
SELECT ?p ?sl (SAMPLE(?lf) AS ?fr) (SAMPLE(?le) AS ?en) (SAMPLE(?df) AS ?desc) (SAMPLE(?de) AS ?descEn)
  (MIN(?b) AS ?born) (MIN(?d) AS ?died) (SAMPLE(?im) AS ?img) WHERE {
  VALUES ?p { ${ids.map((x) => `wd:${x}`).join(' ')} }
  ?p wdt:P31 wd:Q5 ; wikibase:sitelinks ?sl .
  OPTIONAL { ?p rdfs:label ?lf . FILTER(LANG(?lf) = "fr") }
  OPTIONAL { ?p rdfs:label ?le . FILTER(LANG(?le) = "en") }
  OPTIONAL { ?p schema:description ?df . FILTER(LANG(?df) = "fr") }
  OPTIONAL { ?p schema:description ?de . FILTER(LANG(?de) = "en") }
  OPTIONAL { ?p wdt:P569 ?b } OPTIONAL { ?p wdt:P570 ?d } OPTIONAL { ?p wdt:P18 ?im }
} GROUP BY ?p ?sl`;
  const rows = await sparql(q, 20_000);
  return rows
    .sort((a, b) => Number(b.sl?.value ?? 0) - Number(a.sl?.value ?? 0))
    .map((b) => ({
      qid: qidOf(b.p!.value),
      name: b.fr?.value ?? b.en?.value ?? qidOf(b.p!.value),
      description: b.desc?.value ?? b.descEn?.value ?? null,
      born: b.born?.value ? parseYear(b.born.value) : null,
      died: b.died?.value ? parseYear(b.died.value) : null,
      image: b.img?.value ? commonsThumb(b.img.value, 160) : null,
    }));
}

const ROYAL = /\b(roi|reine|empereur|impératrice|pape|sultan|sultane|tsar|tsarine|monarque|pharaon|calife|shah|chah|khan|négus|king|queen|emperor|empress|pope|monarch|pharaoh|caliph)\b/i;
const CORONATION = /couronnement|sacre|coronation|intronisation|enthronement/i;
const MARRIAGE = /mariage|noces|wedding|marriage/i;
const BATTLE = /bataille|siège|battle|siege|combat|assaut/i;
/** Wars, revolutions, campaigns: long and wide, their coordinates are a map's middle, not a place. */
const LONG_AFFAIR = /\b(guerres?|coalition|campagne|révolution|dissolution|empire|war|wars|campaign|revolution|crusade|croisade)\b/i;
/** Things a person "took part in" that are not moments of their life. */
const NOT_A_MOMENT = /exhibition|exposition|film|television|book|podcast|award ceremony|commemoration|anniversary/i;

function eventKind(label: string, classes = ''): ActivityKind {
  const text = `${label} ${classes}`;
  if (CORONATION.test(text)) return 'coronation';
  if (MARRIAGE.test(text)) return 'marriage';
  if (BATTLE.test(text)) return 'battle';
  return 'event';
}

/** A life as dated, placed moments (sorted), from three simple queries. */
export async function personJourney(qid: string): Promise<PersonJourney | null> {
  const basic = `
SELECT (SAMPLE(?lf) AS ?fr) (SAMPLE(?le) AS ?en) (SAMPLE(?df) AS ?desc) (SAMPLE(?de) AS ?descEn) (SAMPLE(?im) AS ?img)
  (MIN(?b) AS ?born) (MIN(?d) AS ?died) (SAMPLE(?bc) AS ?bcoord) (SAMPLE(?dc) AS ?dcoord)
  (SAMPLE(?bpl) AS ?bplace) (SAMPLE(?dpl) AS ?dplace) WHERE {
  BIND(wd:${qid} AS ?p)
  OPTIONAL { ?p rdfs:label ?lf . FILTER(LANG(?lf) = "fr") }
  OPTIONAL { ?p rdfs:label ?le . FILTER(LANG(?le) = "en") }
  OPTIONAL { ?p schema:description ?df . FILTER(LANG(?df) = "fr") }
  OPTIONAL { ?p schema:description ?de . FILTER(LANG(?de) = "en") }
  OPTIONAL { ?p wdt:P18 ?im }
  OPTIONAL { ?p wdt:P569 ?b } OPTIONAL { ?p wdt:P570 ?d }
  OPTIONAL { ?p wdt:P19 ?bp . ?bp wdt:P625 ?bc . OPTIONAL { ?bp rdfs:label ?bpl . FILTER(LANG(?bpl) = "fr") } }
  OPTIONAL { ?p wdt:P20 ?dp . ?dp wdt:P625 ?dc . OPTIONAL { ?dp rdfs:label ?dpl . FILTER(LANG(?dpl) = "fr") } }
}`;
  const statements = `
SELECT ?prop ?val ?valLabel ?s ?e ?t ?qc ?vc ?pc ?vt ?vs WHERE {
  VALUES ?prop { p:P551 p:P937 p:P69 p:P108 p:P39 p:P793 p:P1344 }
  wd:${qid} ?prop ?st .
  ?pp wikibase:claim ?prop ; wikibase:statementProperty ?ps .
  ?st ?ps ?val .
  OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } OPTIONAL { ?st pq:P585 ?t }
  OPTIONAL { ?st pq:P276/wdt:P625 ?qc }
  OPTIONAL { ?val wdt:P625 ?vc }
  OPTIONAL { ?val wdt:P276/wdt:P625 ?pc }
  OPTIONAL { ?val wdt:P585 ?vt } OPTIONAL { ?val wdt:P580 ?vs }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
} LIMIT 3000`;
  // Battles they commanded or fought in, coronations, councils: events naming them.
  const events = `
SELECT ?ev ?evLabel ?t ?s ?c ?lc (GROUP_CONCAT(DISTINCT ?clsL; separator="|") AS ?cls) WHERE {
  { ?ev wdt:P710|wdt:P1037|wdt:P1346|wdt:P664|wdt:P4791 wd:${qid} }
  UNION { ?ev p:P710 ?ps . ?ps pq:P4791 wd:${qid} }
  OPTIONAL { ?ev wdt:P585 ?t } OPTIONAL { ?ev wdt:P580 ?s }
  OPTIONAL { ?ev wdt:P625 ?c } OPTIONAL { ?ev wdt:P276/wdt:P625 ?lc }
  OPTIONAL { ?ev wdt:P31 ?k . ?k rdfs:label ?clsL . FILTER(LANG(?clsL) = "en") }
  FILTER(BOUND(?t) || BOUND(?s))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
} GROUP BY ?ev ?evLabel ?t ?s ?c ?lc LIMIT 400`;
  const [b0, st, ev] = await Promise.all([
    sparql(basic, 30_000),
    sparql(statements, 30_000).catch(() => []),
    sparql(events, 30_000).catch(() => []),
  ]);
  const b = b0[0];
  if (!b || (!b.fr && !b.en)) return null;
  const born = decimalYear(b.born?.value);
  const died = decimalYear(b.died?.value);
  const stops: JourneyStop[] = [];
  const bc = point(b.bcoord?.value);
  if (born !== null) {
    stops.push({ kind: 'birth', label: b.bplace?.value ?? 'Naissance', qid: null, lat: bc?.lat ?? null, lon: bc?.lon ?? null, start: born, end: null });
  }
  const dc = point(b.dcoord?.value);
  if (died !== null) {
    stops.push({ kind: 'death', label: b.dplace?.value ?? 'Mort', qid: null, lat: dc?.lat ?? null, lon: dc?.lon ?? null, start: died, end: null });
  }

  const seen = new Set<string>();
  for (const r of st) {
    const prop = qidOf(r.prop!.value);
    const label = r.valLabel?.value;
    const start = decimalYear(r.s?.value) ?? decimalYear(r.t?.value) ?? decimalYear(r.vt?.value) ?? decimalYear(r.vs?.value);
    if (!isLabel(label) || start === null) continue;
    const end = decimalYear(r.e?.value);
    // An office is not a trip to its capital (co-prince of Andorra), a war not a stay at its middle.
    const placed = prop !== 'P39' && !LONG_AFFAIR.test(label!);
    const at = point(r.qc?.value) ?? (placed ? point(r.vc?.value) ?? point(r.pc?.value) : null);
    let kind: ActivityKind;
    if (prop === 'P69') kind = 'study';
    else if (prop === 'P551') kind = 'stay';
    else if (prop === 'P937' || prop === 'P108') kind = 'work';
    else if (prop === 'P39') kind = ROYAL.test(label!) ? 'reign' : 'office';
    else kind = eventKind(label!);
    const key = `${kind}|${label}|${Math.round(start * 12)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stops.push({ kind, label: label!, qid: qidOf(r.val!.value), lat: at?.lat ?? null, lon: at?.lon ?? null, start, end: end !== null && end > start ? end : null });
  }
  for (const r of ev) {
    const label = r.evLabel?.value;
    const classes = r.cls?.value ?? '';
    const start = decimalYear(r.t?.value) ?? decimalYear(r.s?.value);
    if (!isLabel(label) || start === null || NOT_A_MOMENT.test(classes)) continue;
    // Events named after them long after their death are not moments of their life.
    if (died !== null && start > died + 1) continue;
    const at = LONG_AFFAIR.test(`${label} ${classes}`) ? null : point(r.c?.value) ?? point(r.lc?.value);
    const kind = eventKind(label!, classes);
    const key = `${kind}|${label}|${Math.round(start * 12)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stops.push({ kind, label: label!, qid: qidOf(r.ev!.value), lat: at?.lat ?? null, lon: at?.lon ?? null, start, end: null });
  }
  // A reign without its coronation: the reign's first day is one.
  for (const s of [...stops]) {
    if (s.kind === 'reign' && !stops.some((o) => o.kind === 'coronation' && Math.abs(o.start - s.start) < 1.5)) {
      stops.push({ ...s, kind: 'coronation', end: null });
    }
  }
  stops.sort((x, y) => x.start - y.start);
  return {
    qid,
    name: b.fr?.value ?? b.en!.value,
    description: b.desc?.value ?? b.descEn?.value ?? null,
    image: b.img?.value ? commonsThumb(b.img.value, 240) : null,
    born, died, stops,
  };
}

const BATTLE_CLASSES = 'wd:Q178561 wd:Q188055 wd:Q1261499';

/**
 * Armies of the wars fought during a decade: each side of each war, with the
 * battles it fought in that war (all of them, not only the decade's), in
 * order. A battle listed under several wars goes to the most specific one.
 */
export async function armiesOfDecade(decade: number): Promise<Army[]> {
  // Two simple queries: WDQS gives up on the nested one (502 after 40 s).
  const wars = (await sparql(`
SELECT DISTINCT ?war WHERE {
  VALUES ?cls { ${BATTLE_CLASSES} }
  ?b0 wdt:P31 ?cls .
  ?b0 wdt:P585 ?t0 .
  FILTER(?t0 >= ${yearLiteral(decade)} && ?t0 < ${yearLiteral(decade + 10)})
  ?b0 wdt:P361 ?war .
} LIMIT 80`, 30_000)).map((r) => qidOf(r.war!.value));
  if (!wars.length) return [];
  const q = `
SELECT ?war ?warLabel ?b ?bLabel ?t ?c ?side ?sideLabel ?cmdLabel WHERE {
  VALUES ?war { ${wars.map((w) => `wd:${w}`).join(' ')} }
  VALUES ?cls2 { ${BATTLE_CLASSES} }
  ?b wdt:P361 ?war ; wdt:P31 ?cls2 ; wdt:P585 ?t ; wdt:P625 ?c .
  OPTIONAL {
    ?b p:P710 ?ps . ?ps ps:P710 ?side .
    FILTER NOT EXISTS { ?side wdt:P31 wd:Q5 }
    OPTIONAL { ?ps pq:P4791 ?cmd }
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
} LIMIT 8000`;
  const rows = await sparql(q, 60_000);
  // battle -> facts
  interface B { qid: string; label: string; t: number; lat: number; lon: number; wars: Set<string>; sides: Map<string, { label: string; cmd: Set<string> }> }
  const battles = new Map<string, B>();
  const warLabels = new Map<string, string>();
  for (const r of rows) {
    const bq = qidOf(r.b!.value);
    const war = qidOf(r.war!.value);
    const t = decimalYear(r.t?.value);
    const c = point(r.c?.value);
    if (t === null || !c || !isLabel(r.bLabel?.value)) continue;
    if (isLabel(r.warLabel?.value)) warLabels.set(war, r.warLabel!.value);
    let bt = battles.get(bq);
    if (!bt) {
      bt = { qid: bq, label: r.bLabel!.value, t, lat: c.lat, lon: c.lon, wars: new Set(), sides: new Map() };
      battles.set(bq, bt);
    }
    bt.wars.add(war);
    if (r.side && isLabel(r.sideLabel?.value)) {
      const sq = qidOf(r.side.value);
      const side = bt.sides.get(sq) ?? { label: r.sideLabel!.value, cmd: new Set<string>() };
      if (isLabel(r.cmdLabel?.value)) side.cmd.add(r.cmdLabel!.value);
      bt.sides.set(sq, side);
    }
  }
  const warSize = new Map<string, number>();
  for (const b of battles.values()) for (const w of b.wars) warSize.set(w, (warSize.get(w) ?? 0) + 1);
  const byWar = new Map<string, B[]>();
  for (const b of battles.values()) {
    const war = [...b.wars].filter((w) => warLabels.has(w)).sort((x, y) => warSize.get(x)! - warSize.get(y)!)[0];
    if (!war) continue;
    byWar.set(war, [...(byWar.get(war) ?? []), b]);
  }
  const armies: Army[] = [];
  for (const [war, list] of byWar) {
    list.sort((a, b) => a.t - b.t);
    // The two sides seen most often; a war without known sides still has one army.
    const count = new Map<string, { label: string; n: number }>();
    for (const b of list) for (const [sq, s] of b.sides) count.set(sq, { label: s.label, n: (count.get(sq)?.n ?? 0) + 1 });
    const sides = [...count.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 2);
    const make = (sideQid: string | null, side: string): Army => ({
      id: `${war}:${sideQid ?? 'x'}`,
      war: warLabels.get(war)!,
      warQid: war,
      side,
      sideQid,
      battles: list
        .filter((b) => !sideQid || b.sides.size === 0 || b.sides.has(sideQid))
        .map((b): ArmyBattle => ({
          qid: b.qid, label: b.label, t: b.t, lat: b.lat, lon: b.lon,
          commanders: sideQid ? [...(b.sides.get(sideQid)?.cmd ?? [])].slice(0, 3) : [],
        })),
    });
    if (!sides.length) armies.push(make(null, warLabels.get(war)!));
    for (const [sq, s] of sides) armies.push(make(sq, s.label));
  }
  return armies.filter((a) => a.battles.length > 0);
}
