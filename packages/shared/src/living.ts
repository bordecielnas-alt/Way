import type { Source } from './poi.ts';
import { histToAstro, MAX_YEAR } from './years.ts';

// Monde vivant: what grows, travels and spreads with time. Cities swell and
// shrink (figures of Reba et al. 2016); trade routes, epidemics and
// diffusions (religions, techniques) are flows: dated places, each reached
// from another, read in a Wikipedia article by an AI and geocoded.

// ---------- cities ----------

/** A city of geo/cities.json: name, country, lat, lon, certainty (1 best .. 3), [year, population, ...]. */
export type CityRow = [string, string, number, number, number, number[]];

/** A city at a year: its population, and how sure (1 between two figures, less beyond them). */
export interface CityAt { pop: number; sure: number }

/** Years a city stays shown before its first figure and after its last one. */
export function cityMargin(year: number): number {
  return year < 0 ? 100 : year < 1500 ? 50 : 25;
}
/** Two figures further apart than this (years) give a doubtful estimate in between. */
const LONG_GAP = 300;
/** A city still counted in the 1950s is still there today. */
const STILL_THERE = 1950;

/**
 * Population at a (decimal) year: log-linear between two figures (less
 * sure when they are centuries apart), the nearest figure (less sure)
 * within a margin around them, else null.
 */
export function cityAt(series: number[], year: number): CityAt | null {
  const n = series.length / 2;
  if (n === 0) return null;
  const y = (i: number) => histToAstro(series[2 * i]!);
  const p = (i: number) => series[2 * i + 1]!;
  const t = histToAstro(Math.floor(year)) + (year - Math.floor(year));
  if (t < y(0)) return y(0) - t <= cityMargin(series[0]!) ? { pop: p(0), sure: 0.5 } : null;
  const last = n - 1;
  if (t > y(last)) {
    const kept = series[2 * last]! >= STILL_THERE || t - y(last) <= cityMargin(series[2 * last]!);
    return kept ? { pop: p(last), sure: series[2 * last]! >= STILL_THERE ? 1 : 0.5 } : null;
  }
  let i = 0;
  while (i < last && y(i + 1) < t) i++;
  if (i === last || y(i) === t) return { pop: p(i), sure: 1 };
  const f = (t - y(i)) / (y(i + 1) - y(i));
  const sure = y(i + 1) - y(i) > LONG_GAP ? 0.5 : 1;
  return { pop: Math.round(Math.exp(Math.log(p(i)) * (1 - f) + Math.log(p(i + 1)) * f)), sure };
}

/**
 * Drops lone spikes (a figure over `factor` times both neighbors), typos of
 * the sources (Philadelphia with 17.6 million people in 1914).
 */
export function dropSpikes(series: number[], factor = 4): number[] {
  const out: number[] = [];
  const n = series.length / 2;
  for (let i = 0; i < n; i++) {
    const v = series[2 * i + 1]!;
    const prev = i > 0 ? series[2 * i - 1]! : null;
    const next = i < n - 1 ? series[2 * i + 3]! : null;
    const spike = prev !== null && next !== null && v > factor * Math.max(prev, next);
    if (!spike) out.push(series[2 * i]!, v);
  }
  return out;
}

// ---------- flows ----------

export const FLOW_KINDS = ['trade', 'epidemic', 'diffusion'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export const FLOW_LABELS: Record<FlowKind, { label: string; title: string }> = {
  trade: { label: 'Commerce', title: 'Grandes routes commerciales : caravanes et navires en chemin' },
  epidemic: { label: 'Épidémies', title: 'Propagation des grandes épidémies, ville après ville' },
  diffusion: { label: 'Diffusions', title: 'Religions, écritures et techniques qui se répandent' },
};

export interface FlowDef {
  id: string;
  kind: FlowKind;
  title: string;
  /** Years it lasted (historical). */
  start: number;
  end: number;
  /** Articles the stages are read in, best first. */
  articles: { lang: 'fr' | 'en'; title: string }[];
}

const fr = (title: string) => ({ lang: 'fr' as const, title });
const en = (title: string) => ({ lang: 'en' as const, title });

/** The flows the layers know. Each is read once, then kept. */
export const FLOWS: FlowDef[] = [
  // Trade routes
  { id: 'silk-road', kind: 'trade', title: 'Route de la soie', start: -130, end: 1450, articles: [fr('Route de la soie'), en('Silk Road')] },
  { id: 'incense-route', kind: 'trade', title: 'Route de l’encens', start: -700, end: 300, articles: [fr('Route de l\'encens'), en('Incense trade route')] },
  { id: 'amber-road', kind: 'trade', title: 'Route de l’ambre', start: -1000, end: 600, articles: [fr('Route de l\'ambre'), en('Amber Road')] },
  { id: 'royal-road', kind: 'trade', title: 'Route royale perse', start: -500, end: -330, articles: [fr('Route royale'), en('Royal Road')] },
  { id: 'trans-saharan', kind: 'trade', title: 'Commerce transsaharien', start: 300, end: 1600, articles: [fr('Commerce transsaharien'), en('Trans-Saharan trade')] },
  { id: 'varangians-greeks', kind: 'trade', title: 'Route des Varègues aux Grecs', start: 800, end: 1200, articles: [en('Route from the Varangians to the Greeks')] },
  { id: 'hanse', kind: 'trade', title: 'Hanse', start: 1150, end: 1669, articles: [fr('Hanse'), en('Hanseatic League')] },
  { id: 'spice-trade', kind: 'trade', title: 'Route des épices', start: -200, end: 1650, articles: [fr('Histoire du commerce des épices'), en('Spice trade')] },
  { id: 'tea-horse-road', kind: 'trade', title: 'Route du thé et des chevaux', start: 700, end: 1950, articles: [fr('Ancienne route du thé'), en('Tea Horse Road')] },
  { id: 'manila-galleon', kind: 'trade', title: 'Galion de Manille', start: 1565, end: 1815, articles: [fr('Galion de Manille'), en('Manila galleon')] },
  { id: 'triangular-trade', kind: 'trade', title: 'Commerce triangulaire', start: 1550, end: 1850, articles: [fr('Commerce triangulaire'), en('Triangular trade')] },
  // Epidemics
  { id: 'plague-athens', kind: 'epidemic', title: 'Peste d’Athènes', start: -430, end: -426, articles: [fr('Peste d\'Athènes'), en('Plague of Athens')] },
  { id: 'antonine-plague', kind: 'epidemic', title: 'Peste antonine', start: 165, end: 180, articles: [fr('Peste antonine'), en('Antonine Plague')] },
  { id: 'justinian-plague', kind: 'epidemic', title: 'Peste de Justinien', start: 541, end: 549, articles: [fr('Peste de Justinien'), en('Plague of Justinian')] },
  { id: 'black-death', kind: 'epidemic', title: 'Peste noire', start: 1346, end: 1353, articles: [fr('Peste noire'), en('Black Death')] },
  { id: 'marseille-plague', kind: 'epidemic', title: 'Peste de Marseille', start: 1720, end: 1722, articles: [fr('Peste de Marseille (1720)'), en('Great Plague of Marseille')] },
  { id: 'cholera-1', kind: 'epidemic', title: 'Première pandémie de choléra', start: 1817, end: 1824, articles: [en('1817–1824 cholera pandemic')] },
  { id: 'cholera-2', kind: 'epidemic', title: 'Deuxième pandémie de choléra', start: 1826, end: 1837, articles: [en('1826–1837 cholera pandemic'), fr('Deuxième pandémie de choléra')] },
  { id: 'third-plague', kind: 'epidemic', title: 'Troisième pandémie de peste', start: 1855, end: 1920, articles: [en('Third plague pandemic'), fr('Peste de Chine')] },
  { id: 'flu-1889', kind: 'epidemic', title: 'Grippe de 1889-1890', start: 1889, end: 1890, articles: [en('1889–1890 pandemic')] },
  { id: 'spanish-flu', kind: 'epidemic', title: 'Grippe espagnole', start: 1918, end: 1920, articles: [fr('Grippe espagnole'), en('Spanish flu')] },
  { id: 'covid-19', kind: 'epidemic', title: 'Pandémie de Covid-19', start: 2019, end: 2023, articles: [fr('Pandémie de Covid-19'), en('COVID-19 pandemic')] },
  // Diffusions
  { id: 'neolithic', kind: 'diffusion', title: 'Agriculture en Europe', start: -5000, end: -3000, articles: [en('Neolithic Europe')] },
  { id: 'bantu', kind: 'diffusion', title: 'Expansion bantoue', start: -3000, end: 500, articles: [fr('Expansion bantoue'), en('Bantu expansion')] },
  { id: 'austronesian', kind: 'diffusion', title: 'Expansion austronésienne', start: -3000, end: 1300, articles: [en('Austronesian peoples')] },
  { id: 'alphabet', kind: 'diffusion', title: 'Alphabet', start: -1800, end: 500, articles: [en('History of the alphabet'), fr('Histoire de l\'alphabet')] },
  { id: 'buddhism', kind: 'diffusion', title: 'Bouddhisme', start: -500, end: 1300, articles: [en('Silk Road transmission of Buddhism')] },
  { id: 'christianity', kind: 'diffusion', title: 'Christianisme', start: 30, end: 1400, articles: [en('Spread of Christianity'), fr('Christianisation')] },
  { id: 'islam', kind: 'diffusion', title: 'Islam', start: 610, end: 1600, articles: [en('Spread of Islam'), fr('Expansion de l\'islam')] },
  { id: 'paper', kind: 'diffusion', title: 'Papier', start: -100, end: 1500, articles: [en('History of paper'), fr('Histoire du papier')] },
  { id: 'gunpowder', kind: 'diffusion', title: 'Poudre à canon', start: 850, end: 1500, articles: [en('History of gunpowder')] },
  { id: 'printing', kind: 'diffusion', title: 'Imprimerie', start: 1450, end: 1600, articles: [en('Global spread of the printing press'), fr('Histoire de l\'imprimerie')] },
  { id: 'reformation', kind: 'diffusion', title: 'Réforme protestante', start: 1517, end: 1650, articles: [fr('Réforme protestante'), en('Reformation')] },
  { id: 'railways', kind: 'diffusion', title: 'Chemin de fer', start: 1825, end: 1920, articles: [en('History of rail transport'), fr('Histoire des chemins de fer')] },
];

/** A place a flow reached, and when; `from`: the stage it came from (index), null for a starting point. */
export interface FlowStage {
  place: string;
  lat: number;
  lon: number;
  year: number;
  from: number | null;
  /** What happened there, in a few French words. */
  note: string;
}

export interface Flow {
  id: string;
  stages: FlowStage[];
  /** The article the stages were read in. */
  source: Source;
  /** Who read it (the AI provider), for the record. */
  provider: string | null;
}

export type FlowStatus = 'ready' | 'pending' | 'no-ai' | 'empty';

/** GET /api/flows: the flows of a period, read or being read. */
export interface FlowsResponse {
  flows: { id: string; status: FlowStatus; flow: Flow | null }[];
  /** The AI reading the flows still pending. */
  ai?: string | null;
}

/** Flows of these kinds lasting at least in part within [t0, t1] (historical years). */
export function flowsIn(t0: number, t1: number, kinds: readonly FlowKind[] = FLOW_KINDS): FlowDef[] {
  return FLOWS.filter((f) => kinds.includes(f.kind) && f.start <= t1 && f.end + afterglow(f) >= t0);
}

/** Years an epidemic's traces stay on the map after it ends. */
function afterglow(f: FlowDef): number {
  return f.kind === 'epidemic' ? Math.max(1, Math.round((f.end - f.start) / 4)) : f.kind === 'diffusion' ? MAX_YEAR - f.end : 0;
}

/** Years a stage stays "hot" (the front of a spread) after it is reached. */
export function heat(f: FlowDef): number {
  const span = Math.max(1, histToAstro(f.end) - histToAstro(f.start));
  return f.kind === 'epidemic' ? Math.max(0.5, span / 5) : Math.max(5, span / 8);
}

/** A stage as drawn at a year: `hot` 1 when just reached, down to 0. */
export interface StageView { i: number; hot: number }

/**
 * What a flow shows at a (decimal) year: the stages reached, how hot each
 * is, and the ways between them. Nothing outside its time.
 */
export function flowView(def: FlowDef, flow: Pick<Flow, 'stages'>, year: number): { stages: StageView[]; edges: [number, number][] } {
  const empty = { stages: [], edges: [] };
  const t = histToAstro(Math.floor(year)) + (year - Math.floor(year));
  const t0 = histToAstro(def.start);
  const t1 = histToAstro(def.end) + afterglow(def);
  if (t < t0 || t > t1 + 1) return empty;
  const h = heat(def);
  const stages: StageView[] = [];
  const shown = new Set<number>();
  flow.stages.forEach((s, i) => {
    const at = histToAstro(Math.max(def.start, s.year));
    if (at > t) return;
    shown.add(i);
    stages.push({ i, hot: Math.max(0, 1 - (t - at) / h) });
  });
  const edges = flow.stages.flatMap((s, i): [number, number][] =>
    s.from !== null && shown.has(i) && shown.has(s.from) ? [[s.from, i]] : [],
  );
  return { stages, edges };
}
