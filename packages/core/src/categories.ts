import type { Category, Theme } from '@way/shared';
import { wikidata } from '@way/providers';
import type { Store } from './store/types.ts';

// Root Wikidata classes per category, in priority order: an entity whose
// class descends from several roots gets the first matching category.
const ROOTS: [Category, string[]][] = [
  ['battle', ['Q178561', 'Q188055', 'Q180684', 'Q645883', 'Q350604', 'Q198']],
  ['disaster', ['Q3839081', 'Q8065', 'Q7944', 'Q7692360', 'Q3241045', 'Q12184']],
  ['polity', ['Q3024240', 'Q6256', 'Q7275', 'Q48349', 'Q417175', 'Q1250464']],
  // Settlements outrank "archaeological site": Alexandria is a city first.
  ['city', ['Q486972', 'Q515', 'Q7930989', 'Q15661340']],
  // Castles and walls belong to war, before "monument" claims them.
  ['fortification', ['Q57821', 'Q23413']],
  ['religion', ['Q24398318', 'Q1370598', 'Q2977', 'Q44613', 'Q16970', 'Q44539', 'Q32815']],
  ['exploration', ['Q2401485']],
  ['discovery', ['Q839954']],
  ['art', ['Q838948', 'Q207694', 'Q4502142']],
  ['science', ['Q3918', 'Q62832', 'Q31855', 'Q2385804']],
  ['trade', ['Q44782', 'Q1248784', 'Q55488', 'Q34442', 'Q728937', 'Q1195942']],
  ['nature', ['Q271669', 'Q8502', 'Q4022', 'Q23397', 'Q8072', 'Q23442', 'Q4421', 'Q473972']],
  ['monument', ['Q4989906', 'Q811979', 'Q41176', 'Q16560', 'Q33506']],
  ['person', ['Q5']],
  ['event', ['Q1190554', 'Q1656682', 'Q13418847', 'Q131569', 'Q10931', 'Q11514315']],
];

/**
 * Cached class answers are keyed with this prefix: bump it when ROOTS
 * change, so classes are resolved again against the new roots.
 */
const CLASS_VERSION = 'v2:';

const ROOT_TO_CAT = new Map<string, Category>();
for (const [cat, roots] of ROOTS) for (const r of roots) if (!ROOT_TO_CAT.has(r)) ROOT_TO_CAT.set(r, cat);
const PRIORITY = new Map<Category, number>(ROOTS.map(([c], i) => [c, i]));

function best(cats: Iterable<Category>): Category | null {
  let out: Category | null = null;
  for (const c of cats) if (out === null || PRIORITY.get(c)! < PRIORITY.get(out)!) out = c;
  return out;
}

/** Resolve (and cache) the category of each Wikidata class via P279*. */
export async function classifyClasses(classes: string[], store: Store): Promise<Map<string, Category | null>> {
  const unique = [...new Set(classes)];
  const stored = await store.getClassCategories(unique.map((c) => CLASS_VERSION + c));
  const known = new Map<string, Category | null>();
  for (const [k, v] of stored) known.set(k.slice(CLASS_VERSION.length), v);
  const missing = unique.filter((c) => !known.has(c));
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    let found: Map<string, Set<Category>>;
    try {
      found = await descendants(chunk, ROOT_TO_CAT);
    } catch (e) {
      // Leave these classes unresolved: they will be retried next time.
      console.warn('[categories] class lookup failed:', (e as Error).message);
      continue;
    }
    const resolved = new Map(chunk.map((c) => [c, best(found.get(c) ?? [])] as const));
    await store.setClassCategories(new Map([...resolved].map(([c, cat]) => [CLASS_VERSION + c, cat])));
    for (const [c, cat] of resolved) known.set(c, cat);
  }
  return known;
}

/** Which of `roots` each class descends from (P279*), mapped to their values. */
async function descendants<T>(classes: string[], roots: Map<string, T>): Promise<Map<string, Set<T>>> {
  const rows = await wikidata.sparql(`
SELECT ?c ?root WHERE {
  VALUES ?c { ${classes.map((c) => `wd:${c}`).join(' ')} }
  VALUES ?root { ${[...roots.keys()].map((r) => `wd:${r}`).join(' ')} }
  ?c wdt:P279* ?root .
}`, 30_000);
  const found = new Map<string, Set<T>>();
  for (const b of rows) {
    const c = b.c!.value.split('/').pop()!;
    const v = roots.get(b.root!.value.split('/').pop()!);
    if (v !== undefined) (found.get(c) ?? found.set(c, new Set()).get(c)!).add(v);
  }
  return found;
}

export function categoryFor(
  classes: string[], classMap: Map<string, Category | null>, dateProp: string,
): Category {
  const cat = best(classes.map((c) => classMap.get(c)).filter((c): c is Category => !!c));
  if (cat) return cat;
  return dateProp === 'P585' ? 'event' : 'place';
}

// ---------- people: their themes from their occupations and offices ----------

/** Root occupations and offices per theme (a king is a monarch, a pope a cleric…). */
const ROLE_ROOTS: [Theme, string[]][] = [
  ['war', ['Q47064', 'Q189290', 'Q4991371', 'Q1402561']],
  ['state', ['Q82955', 'Q116', 'Q372436', 'Q193391', 'Q48352', 'Q2285706', 'Q39018']],
  ['religion', ['Q2259532', 'Q1234713', 'Q42603', 'Q19546', 'Q29182', 'Q733786', 'Q250867']],
  ['culture', ['Q483501', 'Q36180', 'Q42973', 'Q639669', 'Q49757', 'Q1028181', 'Q1281618', 'Q36834', 'Q33999']],
  ['knowledge', ['Q901', 'Q205375', 'Q4964182', 'Q39631', 'Q170790', 'Q201788', 'Q169470', 'Q11063', 'Q81096']],
  ['trade', ['Q215536', 'Q43845', 'Q131524', 'Q806798']],
  ['exploration', ['Q11900058', 'Q11631']],
];
const ROLE_ROOT = new Map<string, Theme>();
for (const [theme, roots] of ROLE_ROOTS) for (const r of roots) ROLE_ROOT.set(r, theme);

/** Occupation -> themes, for the life of the process (a few thousand at most). */
const roleCache = new Map<string, Theme[]>();

/** Themes of each person, from their occupations (P106) and offices held (P39). */
export async function personRoles(qids: string[]): Promise<Map<string, Theme[]>> {
  const out = new Map<string, Theme[]>();
  if (!qids.length) return out;
  const roles = new Map<string, string[]>();
  for (let i = 0; i < qids.length; i += 100) {
    const rows = await wikidata.sparql(`
SELECT ?item ?role WHERE {
  VALUES ?item { ${qids.slice(i, i + 100).map((q) => `wd:${q}`).join(' ')} }
  ?item wdt:P106|wdt:P39 ?role .
}`, 30_000);
    for (const b of rows) {
      const item = b.item!.value.split('/').pop()!;
      (roles.get(item) ?? roles.set(item, []).get(item)!).push(b.role!.value.split('/').pop()!);
    }
  }
  const missing = [...new Set([...roles.values()].flat())].filter((r) => !roleCache.has(r));
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const found = await descendants(chunk, ROLE_ROOT);
    for (const r of chunk) roleCache.set(r, [...(found.get(r) ?? [])]);
  }
  for (const [item, rs] of roles) {
    const themes = [...new Set(rs.flatMap((r) => roleCache.get(r) ?? []))];
    if (themes.length) out.set(item, themes);
  }
  return out;
}
