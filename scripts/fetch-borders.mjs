// Downloads historical border snapshots from aourednik/historical-basemaps
// (GPL-3.0) into data/borders. Only snapshots within the app range (>= -5000).
import { mkdir, writeFile, access } from 'node:fs/promises';

const REPO = 'aourednik/historical-basemaps';
const OUT = new URL('../data/borders/', import.meta.url);
const UA = { 'User-Agent': 'Way/0.1 (personal history globe)' };

const list = await (await fetch(`https://api.github.com/repos/${REPO}/contents/geojson`, { headers: UA })).json();
const files = list
  .map((f) => f.name)
  .filter((n) => {
    const m = /^world_(bc)?(\d+)\.geojson$/.exec(n);
    return m && (m[1] ? -Number(m[2]) : Number(m[2])) >= -5000;
  });

await mkdir(OUT, { recursive: true });
for (const name of files) {
  const dest = new URL(name, OUT);
  if (await access(dest).then(() => true, () => false)) continue;
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/master/geojson/${name}`, { headers: UA });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`fetched ${name}`);
}
console.log(`${files.length} snapshots in data/borders`);
