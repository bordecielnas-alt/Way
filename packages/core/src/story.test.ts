import { describe, expect, it } from 'vitest';
import { walkOf, type PersonJourney, type StoryStop } from '@way/shared';
import { grounded } from './links.ts';
import {
  aliveIn, atSea, buildScenarios, contextKey, describeContext, ExtractedScenarios, ExtractedStory, fitsStory, linkMatches, livedThen,
  buildPersonWalk, namedIn, namesMatch, nearEnough, personStops, plausibleYear, sameName, textFitsYear,
} from './story.ts';

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

  const stops = [{ year: 1912 }, { year: 1909 }, { year: 1912 }];
  const step = (stop: number, cast: number[] = []) => ({ stop, text: 'Une étape.', cast });
  const people = ['Joseph Bruce Ismay', 'Edward Smith', 'Thomas Andrews'].map((name) => ({ name, born: null, died: null }));
  /** A scenario whose premise names `who` (any text when invented). */
  const sc = (person: number | null, invented: boolean, steps: ReturnType<typeof step>[], who = person === null ? 'un émigrant' : people[person]?.name ?? 'personne') =>
    ({ title: 'Titre', premise: `Vous êtes ${who}.`, person, invented, steps });

  it('walks scenarios through kept stops only, in the order of time, with the people present', () => {
    const [first, ...rest] = buildScenarios([
      sc(0, false, [step(0, [0, 5, 0]), step(7), step(1, [1]), step(1)]),
      sc(null, true, [step(2)]), // a single step: no walk
    ], stops, people.slice(0, 2));
    expect(rest).toEqual([]);
    expect(first!.steps.map((s) => s.stop)).toEqual([1, 0]);
    expect(first!.steps.map((s) => s.cast)).toEqual([[1], [0]]);
    expect(first!.person).toBe(0);
  });

  it('keeps two real people, one each, then an invented character', () => {
    const walk = [step(0), step(1)];
    const out = buildScenarios([
      sc(null, true, walk), sc(1, false, walk), sc(1, false, walk), sc(0, false, walk), sc(2, false, walk), sc(null, true, walk),
    ], stops, people);
    expect(out.map((x) => (x.invented ? 'invented' : x.person))).toEqual([1, 0, 'invented']);
    // Too few people: invented characters fill in.
    expect(buildScenarios([sc(null, true, walk), sc(null, true, walk), sc(9, false, walk)], stops, []).map((x) => x.invented)).toEqual([true, true]);
  });

  it('follows the person the premise names, whatever number the model gave', () => {
    const walk = [step(0), step(1)];
    // "person: 1" (Smith) but "Vous êtes Thomas Andrews": Andrews it is.
    expect(buildScenarios([sc(1, false, walk, 'Thomas Andrews, architecte naval')], stops, people)[0]!.person).toBe(2);
    // Nobody of the list named: not a real person's scenario.
    expect(buildScenarios([sc(1, false, walk, 'un inconnu')], stops, people)).toEqual([]);
    expect(namedIn('Vous êtes Edward Smith, capitaine', people)).toBe(1);
  });

  it('keeps people within their lifetime: in the cast, and as protagonist from adulthood', () => {
    const smith = { name: 'Edward Smith', born: 1850, died: 1912 };
    const ballard = { name: 'Robert Ballard', born: 1942, died: null };
    const titanic = [{ year: 1909 }, { year: 1912 }, { year: 1985 }];
    const captain = (steps: ReturnType<typeof step>[], who: number) => ({ title: 'Titre', premise: `Vous êtes ${[smith, ballard][who]!.name}.`, person: who, invented: false, steps });
    const [first] = buildScenarios([captain([step(0, [0, 1]), step(1, [0, 1]), step(2, [0, 1])], 0)], titanic, [smith, ballard]);
    expect(first!.steps.map((s) => s.stop)).toEqual([0, 1]); // no 1985 step for a man dead in 1912
    expect(first!.steps.map((s) => s.cast)).toEqual([[0], [0]]); // Ballard was not born
    expect(buildScenarios([captain([step(1), step(2)], 1)], titanic, [smith, ballard])).toEqual([]); // one step left: no walk
    expect(aliveIn(ballard, 1985)).toBe(true);
    expect(aliveIn({ born: 1944, died: null }, 1950, 15)).toBe(false);
  });

  it('drops steps whose text speaks of another year', () => {
    expect(textFitsYear('En 1964, vous assistez à des réunions.', 1973)).toBe(false);
    expect(textFitsYear('Le 4 avril 1973, vous assistez à l’inauguration, dix ans après 1963.', 1973)).toBe(true);
    expect(textFitsYear('Vous embarquez à Southampton.', 1912)).toBe(true);
  });

  it('describes the visitor’s view and keys scenarios by it', () => {
    const ctx = { lens: 'strategist', themes: ['war', 'state', 'geography'] as const, people: true, trail: ['Bataille de Verdun', 'Titanic'] };
    const text = describeContext({ ...ctx, themes: [...ctx.themes] });
    expect(text).toContain('Stratège');
    expect(text).toContain('« Bataille de Verdun » → « Titanic »');
    expect(contextKey({ ...ctx, themes: [...ctx.themes] })).toBe(contextKey({ ...ctx, themes: ['state'], trail: ['Autre', 'Titanic'] }));
    expect(contextKey({ ...ctx, themes: [...ctx.themes] })).not.toBe(contextKey({ ...ctx, themes: [...ctx.themes], lens: 'merchant' }));
  });

  it('tolerates malformed items in the AI answer', () => {
    const v = ExtractedStory.parse({ stops: [{ name: 'x' }], people: 'none' });
    expect(v.stops).toEqual([null]);
    expect(v.people).toEqual([]);
    const w = ExtractedScenarios.parse({ scenarios: [{ title: 'Sans étapes' }, sc(0, false, [step(0), { stop: 'x' } as never])] });
    expect(w.scenarios[0]).toBeNull();
    expect(w.scenarios[1]!.steps[1]).toBeNull();
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

describe('what small models get wrong', () => {
  it('accepts a lightly reworded quote, never a changed date', () => {
    const article = "L'Olympic est lancé le 20 octobre 1910 et le Titanic le 31 mai 1911, jour de la livraison de l'Olympic.";
    expect(grounded(article, 'Le Titanic est lancé le 31 mai 1911.')).toBe(true);
    expect(grounded(article, 'Le Titanic est lancé le 31 mai 1912.')).toBe(false);
    expect(grounded(article, 'Le Titanic est détruit par un incendie en mai.')).toBe(false);
  });

  it('knows a sea from a place, and a namesake from the place asked', () => {
    expect(atSea('Atlantique Nord, près de Terre-Neuve, Canada')).toBe(true);
    expect(atSea('Mer du Nord')).toBe(true);
    expect(atSea('Boulogne-sur-Mer, France')).toBe(false);
    expect(namesMatch('Cobh, Irlande', 'Cobh, Comté de Cork, Irlande')).toBe(true);
    expect(namesMatch('Carpathia', 'Saint-Jean, Gaspésie, Québec, Canada')).toBe(false);
  });

  it('drops years far from the subject (copied from the prompt’s examples)', () => {
    const wtc = { date_start: 1966, date_end: 2001 };
    expect(plausibleYear(wtc, -44)).toBe(false);
    expect(plausibleYear(wtc, 1962)).toBe(true);
    expect(plausibleYear(wtc, 2014)).toBe(true);
  });
});

describe('people found by search', () => {
  it('bear the name asked, whole words only', () => {
    expect(sameName('Robert Ballard', 'Robert Duane Ballard')).toBe(true);
    expect(sameName('Jack Grimm', 'Jack Grimmer')).toBe(false);
  });
});

describe('scenarios played on their own', () => {
  const stop = (name: string, year: number, poi: StoryStop['poi'] = null): StoryStop =>
    ({ phase: 'during', name, label: 'Escale', year, lat: 50, lon: -1, poi });
  const andrews = { qid: 'Q1', name: 'Thomas Andrews', role: 'Architecte', born: 1873, died: 1912, image: null };

  it('writes a card’s scenario out as a self-contained walk', () => {
    const from = { id: 'p1', title: 'Titanic' } as Parameters<typeof walkOf>[0];
    const story = { stops: [stop('Belfast', 1909), stop('Southampton', 1912)], people: [andrews], source: { url: 'u', title: 't', kind: 'wikipedia' as const }, provider: 'x' };
    const w = walkOf(from, story, { title: 'Le chantier', premise: 'Vous êtes Thomas Andrews.', person: 0, invented: false, steps: [{ stop: 1, text: 'Un.', cast: [0, 4] }, { stop: 9, text: 'Hors liste.', cast: [] }] });
    expect(w.id).toBe('p1|Le chantier');
    expect(w.hero?.name).toBe('Thomas Andrews');
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0]).toMatchObject({ place: 'Southampton', year: 1912, text: 'Un.' });
    expect(w.steps[0]!.cast.map((p) => p.qid)).toEqual(['Q1']);
  });

  const journey: PersonJourney = {
    qid: 'Q1', name: 'Thomas Andrews', description: 'architecte naval', image: null, born: 1873.1, died: 1912.3,
    stops: [
      { kind: 'birth', label: 'Comber', qid: null, lat: 54.5, lon: -5.7, start: 1873.1, end: null },
      { kind: 'travel', label: 'en route', qid: null, lat: 54, lon: -5, start: 1890, end: null },
      { kind: 'work', label: 'Harland & Wolff', qid: null, lat: 54.6, lon: -5.9, start: 1889.5, end: 1912 },
      { kind: 'stay', label: 'Inconnu', qid: null, lat: null, lon: null, start: 1900, end: null },
    ],
  };

  it('gathers the places of a life: card stories within their lifetime, then their placed Wikidata moments', () => {
    const stops = personStops(journey, [{ title: 'Titanic', stops: [stop('Southampton', 1912), stop('Épave retrouvée', 1985)] }]);
    expect(stops.map((s) => `${s.place} ${s.year}`)).toEqual(['Comber 1873', 'Harland & Wolff 1889', 'Southampton 1912']);
    expect(stops[2]!.card).toBe('Titanic');
    expect(stops[0]!.label).toBe('Naissance');
  });

  it('tells a moment once when the story and Wikidata both place it', () => {
    const atSea = { ...journey, stops: [...journey.stops, { kind: 'death' as const, label: 'Atlantique Nord', qid: null, lat: 50.2, lon: -1.1, start: 1912.3, end: null }] };
    expect(personStops(atSea, [{ title: 'Titanic', stops: [stop('Naufrage', 1912)] }]).map((s) => s.place)).toEqual(['Comber', 'Harland & Wolff', 'Naufrage']);
  });

  it('keeps births, deaths and story stops first when there are too many places', () => {
    const many = personStops(journey, [{ title: 'Titanic', stops: [stop('Southampton', 1912)] }], 2);
    expect(many.map((s) => s.place)).toEqual(['Comber', 'Southampton']);
  });

  it('walks a life through listed places only, in order, while they lived, three steps at least', () => {
    const stops = personStops(journey, [{ title: 'Titanic', stops: [stop('Southampton', 1912)] }]);
    const source = { url: 'u', title: 't', kind: 'wikipedia' as const };
    const item = (steps: { stop: number; text: string }[]) =>
      ({ title: 'Une vie', premise: 'Vous êtes Thomas Andrews.', person: null, invented: false, steps: steps.map((s) => ({ ...s, cast: [] })) });
    const w = buildPersonWalk(item([{ stop: 2, text: 'En 1912, vous embarquez.' }, { stop: 0, text: 'Vous naissez.' }, { stop: 1, text: 'Vous entrez au chantier.' }, { stop: 7, text: 'Hors liste.' }]), stops, andrews, source);
    expect(w?.steps.map((s) => s.place)).toEqual(['Comber', 'Harland & Wolff', 'Southampton']);
    expect(w?.from).toBeNull();
    expect(w?.id).toBe('Q1|Une vie');
    // A text about another year does not fit its stop; two steps are not a walk.
    expect(buildPersonWalk(item([{ stop: 0, text: 'En 1950, rien.' }, { stop: 1, text: 'Un.' }, { stop: 2, text: 'Deux.' }]), stops, andrews, source)).toBeNull();
  });
});
