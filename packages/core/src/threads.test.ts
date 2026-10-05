import { describe, expect, it } from 'vitest';
import { acrossTime, aroundTheWorld, eraWindow } from './threads.ts';

describe('a place across the centuries', () => {
  it('takes the best known moments far apart in time, the card first, in the order of time', () => {
    const at = (year: number, weight: number) => ({ year, weight });
    const card = at(1271, 50);
    const items = [at(1270, 99), at(-500, 10), at(1600, 30), at(1610, 40), at(1950, 60), at(800, 5)];
    expect(acrossTime(items, 4, card).map((x) => x.year)).toEqual([-500, 1271, 1610, 1950]);
  });

  it('weighs modern items less: an old monument before a famous station', () => {
    const items = [{ year: 1990, weight: 100 }, { year: 1100, weight: 40 }];
    expect(acrossTime(items, 1).map((x) => x.year)).toEqual([1100]);
  });
});

describe('the world at one moment', () => {
  const card = (id: string, category: string, lat: number, lon: number, importance: number) =>
    ({ id, category: category as 'battle', lat, lon, importance });

  it('takes one card per theme, far from each other, the visitor\'s themes first, as a tour from where they are', () => {
    const cards = [
      card('acre', 'battle', 32.9, 35.1, 0.9),
      card('krak', 'fortification', 34.8, 36.3, 0.95), // war again, and close to Acre
      card('paris', 'religion', 48.9, 2.3, 0.7),
      card('venise', 'trade', 45.4, 12.3, 0.6),
      card('pekin', 'polity', 39.9, 116.4, 1), // a country tells no single moment
      card('tolede', 'science', 39.9, -4, 0.5),
    ];
    const out = aroundTheWorld(cards, { lat: 45, lon: 10 }, ['trade'], 4);
    expect(out.map((x) => x.theme).sort()).toEqual(['knowledge', 'religion', 'trade', 'war']);
    expect(out.map((x) => x.card.id)).toEqual(['venise', 'paris', 'tolede', 'krak']);
    // Only three steps: the visitor's theme is among them.
    expect(aroundTheWorld(cards, { lat: 45, lon: 10 }, ['trade'], 2).map((x) => x.theme)).toContain('trade');
  });

  it('says "then" with a few years in modern times, decades in antiquity', () => {
    expect(eraWindow(1912)).toEqual([1911, 1913]);
    const [a, b] = eraWindow(-450);
    expect(b - a).toBeGreaterThanOrEqual(40);
  });
});
