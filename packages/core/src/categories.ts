import type { Category } from '@way/shared';
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
  ['religion', ['Q24398318', 'Q1370598', 'Q2977', 'Q44613', 'Q16970', 'Q44539', 'Q32815']],
  ['discovery', ['Q839954']],
  ['art', ['Q838948', 'Q207694', 'Q4502142']],
  ['science', ['Q3918', 'Q62832', 'Q31855', 'Q2385804']],
  ['trade', ['Q44782', 'Q1248784', 'Q55488', 'Q34442', 'Q728937', 'Q1195942']],
  ['nature', ['Q271669', 'Q8502', 'Q4022', 'Q23397', 'Q8072', 'Q23442', 'Q4421', 'Q473972']],
  ['monument', ['Q4989906', 'Q811979', 'Q41176', 'Q23413', 'Q57821', 'Q16560', 'Q33506']],
  ['person', ['Q5']],
  ['event', ['Q1190554', 'Q1656682', 'Q13418847', 'Q131569', 'Q10931', 'Q11514315']],
];

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
  const known = await store.getClassCategories(unique);
  const missing = unique.filter((c) => !known.has(c));
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const found = new Map<string, Set<Category>>();
    try {
      const rows = await wikidata.sparql(`
SELECT ?c ?root WHERE {
  VALUES ?c { ${chunk.map((c) => `wd:${c}`).join(' ')} }
  VALUES ?root { ${[...ROOT_TO_CAT.keys()].map((r) => `wd:${r}`).join(' ')} }
  ?c wdt:P279* ?root .
}`, 30_000);
      for (const b of rows) {
        const c = b.c!.value.split('/').pop()!;
        const cat = ROOT_TO_CAT.get(b.root!.value.split('/').pop()!);
        if (cat) (found.get(c) ?? found.set(c, new Set()).get(c)!).add(cat);
      }
    } catch (e) {
      // Leave these classes unresolved: they will be retried next time.
      console.warn('[categories] class lookup failed:', (e as Error).message);
      continue;
    }
    const resolved = new Map(chunk.map((c) => [c, best(found.get(c) ?? [])] as const));
    await store.setClassCategories(resolved);
    for (const [c, cat] of resolved) known.set(c, cat);
  }
  return known;
}

export function categoryFor(
  classes: string[], classMap: Map<string, Category | null>, dateProp: string,
): Category {
  const cat = best(classes.map((c) => classMap.get(c)).filter((c): c is Category => !!c));
  if (cat) return cat;
  return dateProp === 'P585' ? 'event' : 'place';
}
