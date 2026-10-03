import { describe, expect, it } from 'vitest';
import { buildScenarios, ExtractedStory, fitsStory, linkMatches, livedThen, nearEnough } from './story.ts';

describe('story of a card', () => {
  it('takes an event of the story’s year, or a place that already existed then', () => {
    expect(fitsStory({ year: 1912, prop: 'P585' }, 1912)).toBe(true);
    expect(fitsStory({ year: 1944, prop: 'P585' }, 1912)).toBe(false); // a namesake of another era
    expect(fitsStory({ year: 1250, prop: 'P571' }, 1912)).toBe(true); // Southampton, founded long before
    expect(fitsStory({ year: 1950, prop: 'P571' }, 1912)).toBe(false); // founded after: not the place meant
  });

  it('keeps people born before the story ends', () => {
    expect(livedThen({ born: 1850 }, 1912)).toBe(true);
    expect(livedThen({ born: null }, 1912)).toBe(true);
    expect(livedThen({ born: 1980 }, 1912)).toBe(false);
  });

  it('walks scenarios through kept stops only, in the order of time', () => {
    const stops = [{ name: 'Southampton', year: 1912 }, { name: 'Belfast', year: 1909 }, { name: 'Halifax', year: 1912 }];
    const persons = [{ name: 'Edward Smith' }];
    const [sc, ...rest] = buildScenarios([
      {
        title: 'Le commandant', premise: 'Vous êtes le commandant.', person: 'edward smith',
        steps: [{ stop: 'Southampton', text: 'Départ.' }, { stop: 'Atlantide', text: 'Inventé.' }, { stop: 'Belfast', text: 'Essais.' }, { stop: 'Belfast', text: 'Bis.' }],
      },
      { title: 'Trop court', premise: 'Vous êtes seul ici.', person: null, steps: [{ stop: 'Halifax', text: 'Une étape.' }] },
    ], stops, persons);
    expect(rest).toEqual([]);
    expect(sc!.steps.map((s) => s.stop)).toEqual([1, 0]);
    expect(sc!.person).toBe(0);
  });

  it('tolerates malformed items in the AI answer', () => {
    const v = ExtractedStory.parse({ stops: [{ name: 'x' }], people: 'none', scenarios: [null] });
    expect(v.stops).toEqual([null]);
    expect(v.people).toEqual([]);
  });
});

describe('which item the article means', () => {
  const links = [
    { qid: 'Q1', titles: ['Edward John Smith', 'Edward Smith (commandant)'] },
    { qid: 'Q2', titles: ['Cobh', 'Queenstown (Irlande)'] },
    { qid: 'Q3', titles: ['Smith'] },
    { qid: 'Q4', titles: ['Southampton'] },
  ];

  it('prefers the article’s own links, under their title or a redirect', () => {
    expect(linkMatches('Edward Smith', links)).toEqual(['Q1']);
    expect(linkMatches('Queenstown', links)).toEqual(['Q2']);
    expect(linkMatches('Southampton', links)).toEqual(['Q4']);
    expect(linkMatches('Halifax', links)).toEqual([]);
  });

  it('checks a place against where the geocoders put it', () => {
    const uk = { lat: 50.9, lon: -1.4 };
    const newYork = { lat: 40.88, lon: -72.39, prop: 'P571' as const };
    expect(nearEnough(newYork, uk, false)).toBe(false); // Southampton, New York
    expect(nearEnough({ lat: 50.91, lon: -1.41, prop: 'P571' }, uk, false)).toBe(true);
    expect(nearEnough(newYork, null, false)).toBe(false); // a namesake place, nothing to check it against
    expect(nearEnough(newYork, null, true)).toBe(true);
    expect(nearEnough({ lat: 41.7, lon: -49.9, prop: 'P585' }, { lat: 45, lon: -40 }, true)).toBe(true); // a sinking far out at sea
  });
});
