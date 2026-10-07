import type { Category, PoiLite } from './poi.ts';

/**
 * Themes: what a point is about. A category is a kind of thing (a battle, a
 * castle); a theme groups categories into a family (war). People cross
 * themes: a person belongs to those of their roles (a king to the state, a
 * saint to religion), read from their occupations and offices.
 */
export const THEMES = [
  'geography', 'settlement', 'state', 'war', 'religion', 'culture',
  'knowledge', 'trade', 'exploration', 'disaster', 'society',
] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  geography: 'Géographie',
  settlement: 'Peuplement',
  state: 'État et pouvoir',
  war: 'Guerre',
  religion: 'Religion et croyances',
  culture: 'Culture',
  knowledge: 'Savoir et techniques',
  trade: 'Économie et échanges',
  exploration: 'Explorations',
  disaster: 'Catastrophes',
  society: 'Sociétés et événements',
};

/** The theme of each category; people have none of their own (see `themesOf`). */
export const CATEGORY_THEME: Record<Exclude<Category, 'person'>, Theme> = {
  nature: 'geography',
  city: 'settlement',
  place: 'settlement',
  polity: 'state',
  battle: 'war',
  fortification: 'war',
  religion: 'religion',
  art: 'culture',
  monument: 'culture',
  science: 'knowledge',
  discovery: 'knowledge',
  trade: 'trade',
  exploration: 'exploration',
  disaster: 'disaster',
  event: 'society',
};

/** Categories of each theme, in display order. */
export const THEME_CATEGORIES: Record<Theme, Category[]> = Object.fromEntries(
  THEMES.map((t) => [t, (Object.keys(CATEGORY_THEME) as Exclude<Category, 'person'>[]).filter((c) => CATEGORY_THEME[c] === t)]),
) as Record<Theme, Category[]>;

/** A person's roles are kept in the POI's tags as `role:<theme>`. */
export const ROLE_TAG = 'role:';

export function roleTags(themes: Iterable<Theme>): string[] {
  return [...new Set(themes)].map((t) => `${ROLE_TAG}${t}`);
}

/** Themes of a point: its category's, or a person's roles (none when unknown). */
export function themesOf(p: Pick<PoiLite, 'category' | 'tags'>): Theme[] {
  if (p.category !== 'person') return [CATEGORY_THEME[p.category]];
  const out: Theme[] = [];
  for (const t of p.tags ?? []) {
    if (!t.startsWith(ROLE_TAG)) continue;
    const theme = t.slice(ROLE_TAG.length) as Theme;
    if ((THEMES as readonly string[]).includes(theme)) out.push(theme);
  }
  return out;
}

/** What the viewer chose to see: themes, finer categories inside them, people. */
export interface ThemeFilter {
  hiddenThemes: Theme[];
  hiddenCats: Category[];
  people: boolean;
}

export const ALL_THEMES: ThemeFilter = { hiddenThemes: [], hiddenCats: [], people: true };

/** Whether a point passes the filter. People show when one of their roles is on (or none is known). */
export function makeShown(f: ThemeFilter): (p: Pick<PoiLite, 'category' | 'tags'>) => boolean {
  const themes = new Set(f.hiddenThemes);
  const cats = new Set(f.hiddenCats);
  return (p) => {
    if (cats.has(p.category)) return false;
    if (p.category === 'person') {
      if (!f.people) return false;
      const roles = themesOf(p);
      return roles.length === 0 || roles.some((t) => !themes.has(t));
    }
    return !themes.has(CATEGORY_THEME[p.category]);
  };
}

/** What colors the territories: their realms, their faiths, their peoples and languages, or nothing (the bare relief). */
export type Backdrop = 'political' | 'religion' | 'culture' | 'none';

export const BACKDROP_LABELS: Record<Backdrop, { label: string; title: string }> = {
  political: { label: 'Politique', title: 'Les États et leurs vassaux' },
  religion: { label: 'Religieux', title: 'La religion officielle ou dominante de chaque État' },
  culture: { label: 'Cultures', title: 'Le peuple et la langue de chaque État, par grande famille' },
  none: { label: 'Aucun', title: 'Seulement le relief' },
};

/** A ready-made set of filters: one click to look at the world from one angle. */
export interface Lens {
  id: string;
  label: string;
  title: string;
  /** Themes shown ('all' for every one). */
  themes: Theme[] | 'all';
  people: boolean;
  backdrop: Backdrop;
}

export const LENSES: Lens[] = [
  { id: 'all', label: 'Tout voir', title: 'Tous les thèmes, carte politique', themes: 'all', people: true, backdrop: 'political' },
  { id: 'strategist', label: 'Stratège', title: 'Guerres, pouvoir, fortifications et relief', themes: ['war', 'state', 'geography'], people: true, backdrop: 'political' },
  { id: 'pilgrim', label: 'Pèlerin', title: 'Lieux saints, figures religieuses et carte des religions', themes: ['religion'], people: true, backdrop: 'religion' },
  { id: 'merchant', label: 'Marchand', title: 'Routes, ports, marchés et villes', themes: ['trade', 'settlement', 'exploration'], people: true, backdrop: 'political' },
  { id: 'scholar', label: 'Savant', title: 'Sciences, techniques, découvertes et leurs auteurs', themes: ['knowledge'], people: true, backdrop: 'political' },
  { id: 'traveler', label: 'Voyageur', title: 'Explorations, paysages et sites naturels', themes: ['exploration', 'geography'], people: true, backdrop: 'none' },
  { id: 'builder', label: 'Bâtisseur', title: 'Architecture, monuments, arts et villes', themes: ['culture', 'settlement'], people: true, backdrop: 'political' },
];

// ---------- faiths of the realms (religious backdrop) ----------

export const FAITHS = [
  'christianity', 'islam', 'judaism', 'zoroastrianism', 'hinduism', 'buddhism',
  'jainism', 'sikhism', 'chinese', 'shinto', 'ancient', 'other',
] as const;
export type Faith = (typeof FAITHS)[number];

export const FAITH_LABELS: Record<Faith, string> = {
  christianity: 'Christianisme',
  islam: 'Islam',
  judaism: 'Judaïsme',
  zoroastrianism: 'Zoroastrisme',
  hinduism: 'Hindouisme',
  buddhism: 'Bouddhisme',
  jainism: 'Jaïnisme',
  sikhism: 'Sikhisme',
  chinese: 'Confucianisme et taoïsme',
  shinto: 'Shintô',
  ancient: 'Religions antiques et traditionnelles',
  other: 'Autre',
};

export interface FaithsResponse {
  /** Wikidata item of a realm -> its faith at that year. */
  faiths: Record<string, Faith>;
  /** Items still being looked up (poll again). */
  pending: number;
}

/**
 * A realm's faith read from its name alone, when nothing else says it: a
 * caliphate, a sultanate or an emirate is Muslim, a prince-bishopric or a
 * military order Christian. Null when the name says nothing.
 */
export function faithByName(name: string): Faith | null {
  // Whole words only (accented letters count as letters): "Papalotla" says nothing.
  if (/(?<!\p{L})(?:caliphate|califat|sultanate|sultanat|emirate|émirat|imamate|imamat|beylik|khedivate|khédivat)(?!\p{L})/iu.test(name)) return 'islam';
  if (/(?<!\p{L})(?:prince-bishopric|bishopric|évêché|principauté épiscopale|archbishopric|archevêché|papal|pontifical|pontificaux|crusader|teutonic|teutonique|livonian|hospitaller|hospitaliers|templar|abbey|abbaye)(?!\p{L})/iu.test(name)) {
    return 'christianity';
  }
  return null;
}

// ---------- peoples and languages of the realms (culture backdrop) ----------

/** Great ethnolinguistic families: a realm's people, else its language, falls in one of them. */
export const CULTURES = [
  'latin', 'germanic', 'slavic', 'celtic', 'hellenic', 'baltic', 'iranian', 'indic', 'semitic', 'afroasiatic', 'turkic', 'mongolic',
  'uralic', 'caucasian', 'sinitic', 'tibetoburman', 'japonic', 'seasian', 'austronesian', 'dravidian', 'african', 'american', 'mixed', 'other',
] as const;
export type Culture = (typeof CULTURES)[number];

export const CULTURE_LABELS: Record<Culture, string> = {
  latin: 'Latins et Romans',
  germanic: 'Germaniques',
  slavic: 'Slaves',
  celtic: 'Celtes',
  hellenic: 'Grecs',
  baltic: 'Baltes',
  iranian: 'Iraniens',
  indic: 'Indo-Aryens',
  semitic: 'Sémites',
  afroasiatic: 'Égyptiens, Berbères, Couchites',
  turkic: 'Turcs',
  mongolic: 'Mongols et Toungouses',
  uralic: 'Finno-Ougriens',
  caucasian: 'Caucasiens',
  sinitic: 'Chinois',
  tibetoburman: 'Tibétains et Birmans',
  japonic: 'Japonais et Coréens',
  seasian: 'Tai, Khmers, Viêt',
  austronesian: 'Austronésiens',
  dravidian: 'Dravidiens',
  african: 'Bantous et Niger-Congo',
  american: 'Amérindiens',
  mixed: 'Plusieurs peuples',
  other: 'Autre',
};

export interface CulturesResponse {
  /** Wikidata item of a realm -> its people's family at that year. */
  cultures: Record<string, Culture>;
  /** Items still being looked up (poll again). */
  pending: number;
}
