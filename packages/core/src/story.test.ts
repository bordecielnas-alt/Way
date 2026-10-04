import { describe, expect, it } from 'vitest';
import { walkOf, type PersonJourney, type PoiLite, type StoryStop } from '@way/shared';
import { grounded } from './links.ts';
import {
  aliveIn, applyLabels, buildScenarios, contextKey, describeContext, ExtractedScenarios, livedThen,
  buildPersonWalk, choiceCandidates, detourAsk, ExtractedStep, fillPlan, namesOverlap, nearCards, namedIn, nearMoment, personStops, plausibleYear, stepOf, StoryLabels, textFitsYear, yearOf,
} from './story.ts';

describe('story of a card', () => {
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
    const v = StoryLabels.parse({ stops: [{ i: 'S0' }, { i: 1, label: 'Port de départ', phase: 'pendant', main: 'oui' }], people: 'none' });
    expect(v.stops).toEqual([null, { i: 1, label: 'Port de départ', phase: 'during', main: false }]);
    expect(v.people).toEqual([]);
    const w = ExtractedScenarios.parse({ scenarios: [{ title: 'Sans étapes' }, sc(0, false, [step(0), { text: 'Sans lieu.' } as never])] });
    expect(w.scenarios[0]).toBeNull();
    expect(w.scenarios[1]!.steps[1]).toBeNull();
  });
});

describe('labels over the bones of a story', () => {
  const stop = (label: string, main: boolean) => ({ label, phase: 'during' as const, main });
  const bones = [stop('Histoire', true), stop('Voyage', true), stop('Présentation', false), stop('Postérité', false), stop('Naufrage', true)];
  const persons = [{ role: 'Ingénieur' }, { role: 'Officier de marine' }];

  it('takes the AI’s parts and main places, keeping the stops in their order (scenarios number them)', () => {
    const out = applyLabels(bones, persons, {
      stops: [0, 1, 2, 3, 4].map((i) => ({ i, label: `étape ${i}`, phase: 'before' as const, main: i !== 1 })),
      people: [{ i: 1, role: 'Commandant du navire', main: true }],
    });
    expect(out.stops.map((s) => s.label)).toEqual(['Étape 0', 'Étape 1', 'Étape 2', 'Étape 3', 'Étape 4']);
    expect(out.stops.map((s) => s.main)).toEqual([true, false, true, true, true]);
    expect(out.people.map((p) => p.role)).toEqual(['Commandant du navire', 'Ingénieur']);
  });

  it('keeps the bones’ own main places when the AI marks too few', () => {
    const out = applyLabels(bones, persons, { stops: [{ i: 3, label: 'Épave', phase: 'after', main: true }], people: [] });
    expect(out.stops.map((s) => s.main)).toEqual([true, true, false, false, true]);
    expect(out.stops[3]).toMatchObject({ label: 'Épave', phase: 'after' });
  });

  it('dates a place by its sentence, else by the years its section gives most', () => {
    const m = (year: number | null, section: string, years = year === null ? [] : [year]) => ({ target: 'x', path: [section], field: null, sentence: '', paragraph: '', year, years, order: 0 });
    const all = [m(1912, 'Naufrage'), m(1912, 'Naufrage'), m(1985, 'Naufrage'), m(1909, 'Construction')];
    const ok = (y: number) => y > 1800;
    const titanic = { start: 1909, end: 1912 };
    expect(yearOf(m(1911, 'Construction'), all, ok, titanic)).toBe(1911);
    expect(yearOf(m(null, 'Naufrage'), all, ok, titanic)).toBe(1912);
    expect(yearOf(m(12, 'Ailleurs'), all, ok, titanic)).toBe(1909);
    // "En 2000, une plaque rappelle la défense de 1912": during the story, its own year.
    expect(yearOf(m(2000, 'Naufrage', [2000, 1912]), all, ok, titanic)).toBe(1912);
    // Under "Découverte de l'épave": the later year.
    expect(yearOf(m(1912, 'Découverte de l’épave', [1912, 1985]), all, ok, titanic)).toBe(1985);
  });
});

describe('what small models get wrong', () => {
  it('accepts a lightly reworded quote, never a changed date', () => {
    const article = "L'Olympic est lancé le 20 octobre 1910 et le Titanic le 31 mai 1911, jour de la livraison de l'Olympic.";
    expect(grounded(article, 'Le Titanic est lancé le 31 mai 1911.')).toBe(true);
    expect(grounded(article, 'Le Titanic est lancé le 31 mai 1912.')).toBe(false);
    expect(grounded(article, 'Le Titanic est détruit par un incendie en mai.')).toBe(false);
  });

  it('drops years far from the subject (copied from the prompt’s examples)', () => {
    const wtc = { date_start: 1966, date_end: 2001 };
    expect(plausibleYear(wtc, -44)).toBe(false);
    expect(plausibleYear(wtc, 1962)).toBe(true);
    expect(plausibleYear(wtc, 2014)).toBe(true);
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

  it('offers what the story led to, beyond the walk, as leads for its end', () => {
    const from = { id: 'p1', title: 'Titanic' } as Parameters<typeof walkOf>[0];
    const card = (id: string, title: string) => ({ id, title }) as NonNullable<StoryStop['poi']>;
    const after = (name: string, year: number, poi: StoryStop['poi']): StoryStop => ({ ...stop(name, year, poi), phase: 'after' });
    const story = {
      stops: [
        stop('Southampton', 1912), after('Enquête', 1912, card('e', 'Enquête américaine')), after('Convention', 1914, card('s', 'SOLAS')),
        after('Épave', 1985, null), after('Mémorial', 1913, card('e', 'Enquête américaine')), stop('Arrivée', 1912, card('n', 'New York')),
        after('Rapatriement', 1912, card('n', 'New York')),
      ],
      people: [], source: { url: 'u', title: 't', kind: 'wikipedia' as const }, provider: 'x',
    };
    const w = walkOf(from, story, { title: 'Un', premise: 'Vous êtes un émigrant.', person: null, invented: true, steps: [{ stop: 0, text: 'Un.', cast: [] }, { stop: 2, text: 'Deux.', cast: [] }, { stop: 5, text: 'Trois.', cast: [] }] });
    // A stop or a card already walked through, one without a card, and the same card twice are no leads.
    expect(w.after?.map((l) => l.poi.title)).toEqual(['Enquête américaine']);
  });

  it('keeps the moments nearest to the one branched from, in the order of time', () => {
    const stops = [1850, 1873, 1889, 1909, 1911, 1912, 1985].map((year) => ({ year }));
    expect(nearMoment(stops, 1910).map((s) => s.year)).toEqual([1889, 1909, 1911, 1912]);
    expect(nearMoment(stops, 1910, 2).map((s) => s.year)).toEqual([1909, 1911]);
    expect(nearMoment(stops.slice(0, 1), 1910)).toHaveLength(1);
    expect(detourAsk(1912, 'Le chantier')).toContain('« Le chantier »');
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
    // A detour: two steps are enough, three at most, under its own id.
    const detour = buildPersonWalk(item([{ stop: 1, text: 'Un.' }, { stop: 2, text: 'Deux.' }]), stops, andrews, source, { min: 2, max: 3, id: 'Q1|détour|1910' });
    expect(detour?.steps).toHaveLength(2);
    expect(detour?.id).toBe('Q1|détour|1910');
  });
});

describe('steps written on arrival', () => {
  const stops = [
    { year: 1909, main: true }, { year: 1912, main: true }, { year: 1912, main: false }, { year: 1912, main: true },
    { year: 1913, main: true }, { year: 1985, main: true }, { year: 1911, main: true },
  ];

  it('offers as choices the places not walked yet, from the step’s moment on, nearest first, main ones first', () => {
    expect(choiceCandidates(stops, 1, [0, 1, 4])).toEqual([3, 2, 6, 5]);
    // A real protagonist only where they live then.
    expect(choiceCandidates(stops, 1, [0, 1], (y) => y < 1950)).toEqual([3, 2, 4, 6]);
    expect(choiceCandidates(stops, 9, [])).toEqual([]);
  });

  it('turns a stop of the story into a step to walk, its text to be written', () => {
    const story = { stops: [{ phase: 'during' as const, name: 'Cobh', label: 'Escale', year: 1912, lat: 51.8, lon: -8.3, poi: null, image: 'u.jpg' }] };
    expect(stepOf(story, 0)).toEqual({ place: 'Cobh', label: 'Escale', year: 1912, lat: 51.8, lon: -8.3, poi: null, text: '', cast: [], stop: 0, image: 'u.jpg' });
    expect(stepOf(story, 3)).toBeNull();
  });

  it('tolerates a malformed step answer', () => {
    const v = ExtractedStep.parse({ text: 'Vous débarquez à Cobh au petit matin, sous la pluie, avec les derniers passagers.', cast: ['P1', 'x'], choices: [{ label: 'Suivre les émigrants', to: 'C0' }, { to: 2 }] });
    expect(v.cast).toEqual([1, 0]);
    expect(v.choices).toEqual([{ label: 'Suivre les émigrants', to: { kind: 'C', i: 0 } }, null]);
  });
});

describe('plans filled to the story', () => {
  it('adds the main stops between a short plan’s first and last moments, in the story’s order', () => {
    const stops = [{ year: 1907 }, { year: 1912 }, { year: 1912, main: false }, { year: 1912 }, { year: 1912 }, { year: 1985 }];
    const plan = { title: 'T', premise: 'P', person: null, invented: true, steps: [{ stop: 4, text: '', cast: [] }, { stop: 1, text: '', cast: [] }] };
    expect(fillPlan(plan, stops, [], 4).steps.map((s) => s.stop)).toEqual([1, 3, 4]);
    // Long enough: untouched.
    expect(fillPlan(plan, stops, [], 2)).toBe(plan);
  });
});

describe('around a step', () => {
  const card = (id: string, lat: number, lon: number, start: number, importance: number, end: number | null = null) =>
    ({ id, title: id, category: 'battle', date_start: start, date_end: end, date_precision: 'exact_year', lat, lon, importance, confidence: 'verified', tags: [] }) as unknown as PoiLite;

  it('finds the known cards close by in place and time, the best known first, the story’s own left out', () => {
    const at = { lat: 49.6, lon: -1.6, year: 1912 };
    const town = { ...card('ville', 49.6, -1.6, 1911, 0.95), category: 'city' } as PoiLite;
    const pois = [card('loin', 40, -74, 1912, 0.9), card('tard', 49.5, -1.5, 1950, 0.9), card('a', 49.4, -1.2, 1910, 0.4), card('b', 50.9, -1.4, 1909, 0.8, 1914),
      card('long', 49.5, -1.4, 1880, 0.7, 1960), town, card('own', 49.6, -1.6, 1912, 1)];
    // Events only (not a town), lasting a few years at most.
    expect(nearCards(pois, at, new Set(['own'])).map((p) => p.id)).toEqual(['b', 'a']);
    expect(namesOverlap('Rejoindre le Carpathia', 'RMS Carpathia')).toBe(true);
    expect(namesOverlap('Explorer Cherbourg', 'Huddersfield Town Football Club')).toBe(false);
  });

  it('reads a step answer: facts, a quote, choices to a place of the story or another card', () => {
    const v = ExtractedStep.parse({
      text: 'Vous débarquez à Cobh au petit matin, sous la pluie, avec les derniers passagers qui montent à bord du paquebot.',
      facts: ['11 avril 1912 : escale à Queenstown', 3], quote: 'court',
      choices: [{ label: 'Rejoindre le Carpathia', to: 'K1' }, { label: 'Rester à bord', to: 2 }, { label: 'Nulle part', to: 'X' }],
    });
    expect(v.facts).toEqual(['11 avril 1912 : escale à Queenstown']);
    expect(v.quote).toBeNull();
    expect(v.choices).toEqual([{ label: 'Rejoindre le Carpathia', to: { kind: 'K', i: 1 } }, { label: 'Rester à bord', to: { kind: 'C', i: 2 } }, null]);
  });
});
