// Manual smoke test against live Wikidata/Wikipedia: `npx tsx scripts/smoke-providers.ts`
import { wikidata, wikipedia } from '@way/providers';

const t = Date.now();
const lap = (label: string) => console.log(`${label}: ${Date.now() - t} ms`);

const around = await wikidata.queryAround(41.89, 12.48, 25, -800, -600, 50);
lap(`around Rome -800..-600 -> ${around.length}`);
console.log(around.slice(0, 5));

const global = await wikidata.queryGlobal(1914, 1915, 5, 3000);
lap(`global 1914 -> ${global.length}`);

const info = await wikidata.queryEntityInfo(global.slice(0, 150).map((r) => r.qid));
lap(`entity info -> ${info.size}`);
console.log([...info.values()].slice(0, 3));

const hits = await wikipedia.geosearch('fr', 48.8566, 2.3522, 3000, 50);
lap(`geosearch Paris -> ${hits.length}`);
const s = await wikipedia.pageSummary('fr', 'Prise de la Bastille');
lap('summary');
console.log(s);
