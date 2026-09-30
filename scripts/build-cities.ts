// Builds geo/cities.json, the population of the world's great cities from
// 3700 BCE to 2000 CE, served with the globe (the "Villes" layer), once.
// Source: Reba, Reitsma & Seto, "Spatializing 6,000 years of global
// urbanization from 3700 BC to AD 2000", Scientific Data 3, 160034 (2016),
// CC BY 4.0: Chandler's and Modelski's figures, geocoded.
// Run: npx tsx scripts/build-cities.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dropSpikes } from '../packages/shared/src/living.ts';

const OUT = resolve(import.meta.dirname, '../apps/front/public/geo');
const FILES = {
  chandler: 'https://ndownloader.figshare.com/files/5407640', // chandlerV2.csv
  modelskiAncient: 'https://ndownloader.figshare.com/files/5356132', // modelskiAncientV2.csv
  modelskiModern: 'https://ndownloader.figshare.com/files/5407637', // modelskiModernV2.csv
};
/** Two entries closer than this, with the same name, are one city. */
const SAME_KM = 30;

interface City { name: string; country: string; lat: number; lon: number; certainty: number; pop: Map<number, number> }

/** Minimal CSV: quoted fields may hold commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

/** "BC_2250" -> -2250, "AD_100" -> 100 (historical years, no year 0). */
function yearOf(col: string): number | null {
  const m = /^(BC|AD)_(\d+)$/.exec(col);
  if (!m) return null;
  return m[1] === 'BC' ? -Number(m[2]) : Number(m[2]);
}

function km(a: City, b: City): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function load(url: string): Promise<City[]> {
  const rows = parseCsv(await (await fetch(url)).text());
  const head = rows[0]!;
  const col = (name: string) => head.indexOf(name);
  const years = head.map(yearOf);
  return rows.slice(1).flatMap((r) => {
    const lat = Number(r[col('Latitude')]);
    const lon = Number(r[col('Longitude')]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return [];
    const pop = new Map<number, number>();
    years.forEach((y, i) => {
      const v = Number(r[i]);
      if (y !== null && r[i] && Number.isFinite(v) && v > 0) pop.set(y, v);
    });
    if (pop.size === 0) return [];
    return [{ name: r[col('City')]!, country: r[col('Country')] ?? '', lat, lon, certainty: Number(r[col('Certainty')]) || 3, pop }];
  });
}

const cities: City[] = [];
// Chandler first: on a year both give, his figure is kept.
for (const url of [FILES.chandler, FILES.modelskiAncient, FILES.modelskiModern]) {
  for (const c of await load(url)) {
    const same = cities.find((x) => x.name.toLowerCase() === c.name.toLowerCase() && km(x, c) < SAME_KM);
    if (!same) {
      cities.push(c);
      continue;
    }
    for (const [y, v] of c.pop) if (!same.pop.has(y)) same.pop.set(y, v);
    same.certainty = Math.min(same.certainty, c.certainty);
  }
}

const q = (v: number) => Math.round(v * 100) / 100;
const out = cities
  .map((c) => [c.name, c.country, q(c.lat), q(c.lon), c.certainty, dropSpikes([...c.pop].sort((a, b) => a[0] - b[0]).flat())] as const)
  .sort((a, b) => Math.max(...b[5].filter((_, i) => i % 2)) - Math.max(...a[5].filter((_, i) => i % 2)));
mkdirSync(OUT, { recursive: true });
writeFileSync(
  resolve(OUT, 'cities.json'),
  JSON.stringify({
    source: 'Reba, Reitsma & Seto (2016), Scientific Data 3:160034, CC BY 4.0',
    format: '[name, country, lat, lon, certainty (1 best .. 3), [year, population, year, population, ...]]',
    cities: out,
  }),
);
console.log(`${out.length} cities written to ${OUT}/cities.json`);
