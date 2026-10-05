import { describe, expect, it } from 'vitest';
import { dateToDecimal, forkWalk, walkOf, type PersonJourney, type PoiLite, type StoryStop } from '@way/shared';
import { grounded } from './links.ts';
import {
  aliveIn, applyLabels, buildForks, buildScenarios, byThemes, cleanParagraphs, dayOf, headingIn, momentIn, namedInOrder, orderSteps, stepKey, contextKey, describeContext,
  ExtractedScenarios, headingOf, livedThen, untilDeath, wikiForks,
  buildPersonWalk, choiceCandidates, detourAsk, ExtractedStep, fillPlan, namedAll, namesOverlap, nearCards, namedIn, nearMoment, passageAround, withoutFiller, personStops, plausibleYear, stepOf, StoryLabels, textFitsYear, yearOf,
} from './story.ts';
import { mentionsOf } from './skeleton.ts';

/** A step's paragraphs as a writer gives them. */
const COBH = [
  'Le 11 avril 1912, le Titanic jette l’ancre au large de Queenstown, aujourd’hui Cobh, dernière escale avant la traversée.',
  'Les tenders America et Ireland amènent 123 passagers, pour la plupart des émigrants irlandais de troisième classe.',
];

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

  it('keeps one real person, then a thing and an idea', () => {
    const walk = [step(0), step(1)];
    const thread = (kind: 'thing' | 'idea') => ({ ...sc(null, true, walk), thread: kind });
    const out = buildScenarios([
      thread('thing'), sc(1, false, walk), thread('thing'), sc(0, false, walk), thread('idea'),
    ], stops, people);
    expect(out.map((x) => (x.invented ? x.thread : x.person))).toEqual([1, 'thing', 'idea']);
    // No people: threads fill in, a thread without its kind is a thing.
    expect(buildScenarios([sc(null, true, walk), thread('idea'), sc(9, false, walk)], stops, []).map((x) => x.thread)).toEqual(['thing', 'idea']);
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
    expect(stepOf(story, 0)).toEqual({ place: 'Cobh', label: 'Escale', year: 1912, when: null, lat: 51.8, lon: -8.3, poi: null, text: '', cast: [], stop: 0, image: 'u.jpg' });
    expect(stepOf(story, 3)).toBeNull();
  });

  it('tolerates a malformed step answer', () => {
    const v = ExtractedStep.parse({ paragraphs: [...COBH, null, 42], cast: ['P1', 'x'], choices: [{ label: 'Suivre les émigrants', to: 'C0' }, { to: 2 }] });
    expect(v.paragraphs).toEqual(COBH);
    expect(v.cast).toEqual([1, 0]);
    expect(v.choices).toEqual([{ label: 'Suivre les émigrants', to: { kind: 'C', i: 0 } }, null]);
  });
});

describe('plans filled to the story', () => {
  it('adds the main stops between a short plan’s first and last moments, in the story’s order', () => {
    const stops = [{ year: 1907 }, { year: 1912 }, { year: 1912, main: false }, { year: 1912 }, { year: 1912 }, { year: 1985 }];
    const plan = { title: 'T', premise: 'P', person: null, invented: true, steps: [{ stop: 1, text: '', cast: [] }, { stop: 4, text: '', cast: [] }] };
    expect(fillPlan(plan, stops, [], 4).steps.map((s) => s.stop)).toEqual([1, 3, 4]);
    // Within a year, the planner's order holds; one added goes after the planned step the story tells before it.
    const swapped = { ...plan, steps: [...plan.steps].reverse() };
    expect(fillPlan(swapped, stops, [], 4).steps.map((s) => s.stop)).toEqual([4, 1, 3]);
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
    const pois = [card('loin', 40, -74, 1912, 0.9), card('tard', 49.5, -1.5, 1950, 0.9), card('a', 49.4, -1.2, 1911, 0.4), card('b', 50.9, -1.4, 1909, 0.8, 1914),
      card('long', 49.5, -1.4, 1880, 0.7, 1960), town, card('own', 49.6, -1.6, 1912, 1)];
    // Events only (not a town), lasting a few years at most.
    expect(nearCards(pois, at, new Set(['own'])).map((p) => p.id)).toEqual(['b', 'a']);
    expect(namesOverlap('Rejoindre le Carpathia', 'RMS Carpathia')).toBe(true);
    expect(namesOverlap('Explorer Cherbourg', 'Huddersfield Town Football Club')).toBe(false);
  });

  it('reads a step answer: facts, a quote, choices to a place of the story or another card', () => {
    const v = ExtractedStep.parse({
      paragraphs: COBH,
      facts: ['11 avril 1912 : escale à Queenstown', 3], quote: 'court',
      choices: [{ label: 'Rejoindre le Carpathia', to: 'K1' }, { label: 'Rester à bord', to: 2 }, { label: 'Nulle part', to: 'X' }],
    });
    expect(v.facts).toEqual(['11 avril 1912 : escale à Queenstown']);
    expect(v.quote).toBeNull();
    expect(v.choices).toEqual([{ label: 'Rejoindre le Carpathia', to: { kind: 'K', i: 1 } }, { label: 'Rester à bord', to: { kind: 'C', i: 2 } }, null]);
  });
});

describe('a step read from its whole passage', () => {
  it('takes the passage around the step’s paragraph, at sentence bounds', () => {
    const section = Array.from({ length: 40 }, (_, i) => `Phrase numéro ${i} du récit.`).join(' ');
    const out = passageAround(section, 'Phrase numéro 30 du récit.', 200);
    expect(out).toContain('Phrase numéro 30');
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/^Phrase numéro \d+ du récit\.$|^Phrase.*\.$/);
    expect(passageAround('Court.', 'x', 200)).toBe('Court.');
  });

  it('finds the people a text names by their surname', () => {
    const persons = [{ name: 'Edward Smith' }, { name: 'Jack Phillips' }, { name: 'Cyril Evans' }];
    expect(namedAll('Vous voyez Phillips penché sur le poste, un message d’Evans arrive.', persons)).toEqual([1, 2]);
  });

  it('reads a choice toward someone present', () => {
    const v = ExtractedStep.parse({
      paragraphs: COBH,
      choices: [{ label: 'Suivre Jack Phillips à la radio', to: 'P1' }],
    });
    expect(v.choices).toEqual([{ label: 'Suivre Jack Phillips à la radio', to: { kind: 'P', i: 1 } }]);
  });
});

describe('a step without filler', () => {
  it('drops the sentences that tell nothing, when enough remain', () => {
    const facts = ['À 18 h 35, le Nomadic accoste.', 'Le commandant Smith donne l’ordre.', 'À 20 h 10, le paquebot appareille.', '274 passagers montent.', 'La mer est calme.'];
    const text = [facts[0], 'Vous vous demandez ce qui vous attend.', ...facts.slice(1), 'Le cœur battant, vous montez.'].join(' ');
    expect(withoutFiller(text)).toBe(facts.join(' '));
    // Too little would remain: kept as written.
    expect(withoutFiller('Vous rêvez. Le paquebot part.')).toBe('Vous rêvez. Le paquebot part.');
  });
});

describe('a walk told in the order of its days', () => {
  it('reads the day a sentence gives for a moment of that year', () => {
    expect(dayOf('Le 10 avril 1912, le paquebot quitte Southampton.', 1912)).toBeCloseTo(dateToDecimal(1912, 4, 10));
    expect(dayOf('Le 1er août 1914, la France mobilise.', 1914)).toBeCloseTo(dateToDecimal(1914, 8, 1));
    expect(dayOf('On April 15, 1912 the liner sank.', 1912)).toBeCloseTo(dateToDecimal(1912, 4, 15));
    // Another year's day, or none: no day.
    expect(dayOf('Lancé le 31 mai 1911, il part en 1912.', 1912)).toBeNull();
    expect(dayOf('En 1912, il part.', 1912)).toBeNull();
  });

  it('orders a year by its days, then as planned, and drops the same spot twice in a row', () => {
    const d = (m: number, day: number) => dateToDecimal(1912, m, day);
    const stops = [
      { year: 1912, when: d(4, 18), lat: 40.7, lon: -74 }, // 0 New York
      { year: 1912, when: d(4, 10), lat: 50.9, lon: -1.4 }, // 1 Southampton, the port
      { year: 1912, when: null, lat: 49.6, lon: -1.6 }, // 2 Cherbourg, no day
      { year: 1912, when: d(4, 15), lat: 41.7, lon: -49.9 }, // 3 the wreck
      { year: 1912, when: d(4, 10), lat: 50.91, lon: -1.41 }, // 4 Southampton, the town
      { year: 1909, when: null, lat: 54.6, lon: -5.9 }, // 5 Belfast
    ];
    const plan = [0, 1, 4, 2, 3, 5].map((stop) => ({ stop }));
    // New York planned first, but the 18th comes after the 15th; Cherbourg keeps the day of the step before it.
    expect(orderSteps(plan, stops).map((s) => s.stop)).toEqual([5, 1, 2, 3, 0]);
    // Without a day, far out of the way between the two around it: where the story ends up (the destination), last of its year.
    const voyage = [
      { year: 1912, when: d(4, 10), lat: 50.9, lon: -1.4 }, // 0 Southampton
      { year: 1912, when: null, lat: 51.85, lon: -8.3 }, // 1 Queenstown
      { year: 1912, when: null, lat: 40.7, lon: -74 }, // 2 New York
      { year: 1912, when: null, lat: 46.66, lon: -53.07 }, // 3 Cap Race
      { year: 1912, when: d(4, 15), lat: 41.7, lon: -49.9 }, // 4 the wreck
    ];
    expect(orderSteps([0, 1, 2, 3, 4].map((stop) => ({ stop })), voyage).map((s) => s.stop)).toEqual([0, 1, 3, 4, 2]);
    // A war's fronts far apart are no detour to undo.
    const fronts = [{ year: 1914, lat: 48.85, lon: 2.35 }, { year: 1914, lat: 52.52, lon: 13.4 }, { year: 1914, lat: 40.4, lon: -3.7 }];
    expect(orderSteps([0, 1, 2].map((stop) => ({ stop })), fronts).map((s) => s.stop)).toEqual([0, 1, 2]);
    // Without days, the planner's order within a year.
    expect(orderSteps([{ stop: 2 }, { stop: 1 }], [{ year: 1912 }, { year: 1912 }, { year: 1912 }]).map((s) => s.stop)).toEqual([2, 1]);
  });

  it('keeps turning points at a step, through stops off the route, following someone when the protagonist is real', () => {
    const stops = [1912, 1912, 1912, 1912, 1912, 1909].map((year) => ({ year }));
    const persons = [{ name: 'Edward Smith', born: 1850, died: 1912 }, { name: 'Margaret Brown', born: 1867, died: 1932 }];
    const steps = [{ stop: 0 }, { stop: 1 }, { stop: 2 }];
    const fork = (at: number, label: string, person: number | null, route: number[]) => ({ at, label, person, stops: route });
    // Smith is real: a fork in his own shoes would rewrite history.
    expect(buildForks([fork(1, 'Rester sur le pont', null, [3])], steps, stops, persons, 0)).toEqual([]);
    // Following Margaret Brown (whom the label names), off the route, from that moment on.
    // Another way on: not the walk's own stops (2 is its next one), nothing before that moment (1909).
    expect(buildForks([fork(1, 'Monter dans le canot 6 avec Margaret Brown', 0, [2, 0, 5, 3, 4])], steps, stops, persons, 0))
      .toEqual([{ at: 1, label: 'Monter dans le canot 6 avec Margaret Brown', person: 1, stops: [3, 4] }]);
    // An invented character may turn away in their own shoes; one per step; not at a step off the walk.
    const own = buildForks([fork(0, 'rester à terre', null, [3]), fork(0, 'Encore', null, [4]), fork(9, 'Ailleurs', null, [4]), null], steps, stops, persons, null);
    expect(own).toEqual([{ at: 0, label: 'Rester à terre', person: null, stops: [3] }]);
  });

  it('hangs a turning point on its step, and plays it as a walk of its own', () => {
    const from = { id: 'p1', title: 'Titanic' } as Parameters<typeof walkOf>[0];
    const stop = (name: string): StoryStop => ({ phase: 'during', name, label: 'Escale', year: 1912, lat: 50, lon: -1, poi: null });
    const brown = { qid: 'Q2', name: 'Margaret Brown', role: 'Passagère de première classe', born: 1867, died: 1932, image: null };
    const story = { stops: [stop('Southampton'), stop('Naufrage'), stop('Carpathia'), stop('New York')], people: [brown], source: { url: 'u', title: 't', kind: 'wikipedia' as const }, provider: 'x' };
    const w = walkOf(from, story, {
      title: 'Le voyage', premise: 'Vous êtes un émigrant.', person: null, invented: true,
      steps: [{ stop: 0, text: '', cast: [], beat: 'Trouver une place' }, { stop: 1, text: '', cast: [] }],
      forks: [{ at: 1, label: 'Monter dans le canot 6', person: 0, stops: [2, 3] }],
    });
    expect(w.steps[0]!.beat).toBe('Trouver une place');
    expect(w.steps[1]!.forks?.map((f) => [f.label, f.hero?.name, f.steps.map((s) => s.place)])).toEqual([['Monter dans le canot 6', 'Margaret Brown', ['Carpathia', 'New York']]]);
    const taken = forkWalk({ ...w, steps: w.steps.map((s, j) => (j === 0 ? { ...s, choices: [{ label: 'Aider une famille' }], chosen: 0 } : s)) }, 1, 0)!;
    expect(taken.id).toBe('p1|Le voyage|bifurcation|1|0');
    expect(taken.hero?.name).toBe('Margaret Brown');
    expect(taken.premise).toContain('Margaret Brown');
    expect(taken.prelude).toEqual([0, 1]);
    expect(taken.decisions).toEqual(['Aider une famille', 'Monter dans le canot 6']);
    expect(taken.steps.map((s) => s.place)).toEqual(['Carpathia', 'New York']);
    expect(taken.steps[0]!.cast.map((p) => p.name)).toEqual(['Margaret Brown']);
    expect(forkWalk(w, 0, 0)).toBeNull();
  });

  it('writes a step again when its way on, its turning points or the turns taken change', () => {
    const ask = { stop: 4, walk: [1, 4, 7], decisions: ['Aider une famille'], forks: [{ label: 'Canot 6', stop: 9 }] };
    expect(stepKey(ask)).not.toBe(stepKey({ ...ask, walk: [1, 4, 8] }));
    expect(stepKey(ask)).not.toBe(stepKey({ ...ask, decisions: [] }));
    expect(stepKey(ask)).not.toBe(stepKey({ ...ask, forks: [] }));
    expect(stepKey(ask)).toBe(stepKey({ ...ask, walk: [0, 1, 4, 7] }));
  });

  it('reads the planned way on and turning points in the answers', () => {
    const plan = ExtractedScenarios.parse({ scenarios: [{ title: 'Le voyage', premise: 'Vous êtes un émigrant.', invented: true, steps: [{ stop: 'S1', beat: 'Trouver une place' }], forks: [{ at: 'S1', label: 'Rester à terre', stops: ['S3', 'S4'] }, { at: 2 }] }] });
    expect(plan.scenarios[0]!.steps[0]).toMatchObject({ stop: 1, beat: 'Trouver une place' });
    expect(plan.scenarios[0]!.forks).toEqual([{ at: 1, label: 'Rester à terre', stops: [3, 4] }, null]);
    const step = ExtractedStep.parse({ paragraphs: COBH, next: 'La traversée de l’Atlantique' });
    expect(step.next).toBe('La traversée de l’Atlantique');
    expect(headingOf('l’escale de Cherbourg')).toBe('L’escale de Cherbourg');
    expect(headingOf('1912 · Embarquement des passagers · Cherbourg')).toBeNull();
    expect(headingOf(null)).toBeNull();
  });
});

describe('a step told like an encyclopedia', () => {
  it('reads its paragraphs as a list, or as one text cut at its blank lines, and never too short', () => {
    expect(ExtractedStep.parse({ text: COBH.join('\n\n') }).paragraphs).toEqual(COBH);
    expect(ExtractedStep.parse({ paragraphs: COBH.join('\n\n') }).paragraphs).toEqual(COBH);
    expect(() => ExtractedStep.parse({ paragraphs: ['Le paquebot fait escale à Cobh, puis repart.'] })).toThrow();
  });

  it('keeps no sentence speaking to the reader, no filler, and cuts a long paragraph in two', () => {
    const facts = ['Le paquebot mouille à 11 h 30.', 'Deux tenders amènent 123 passagers.', 'Il repart à 13 h 30.'];
    expect(cleanParagraphs([[facts[0], 'Vous montez à bord, le cœur battant.', ...facts.slice(1)].join(' ')])).toEqual([facts.join(' ')]);
    expect(cleanParagraphs([[...facts, 'La prochaine étape de cette histoire se dirige vers Southampton.'].join(' ')])).toEqual([facts.join(' ')]);
    // Too few left: the paragraph stays as written.
    expect(cleanParagraphs(['Vous voyez le paquebot. Il part.'])).toEqual(['Vous voyez le paquebot. Il part.']);
    const long = Array.from({ length: 8 }, (_, i) => `La phrase ${i} donne le détail des manœuvres du paquebot dans la rade, avec ses horaires.`).join(' ');
    const cut = cleanParagraphs([long], 400);
    expect(cut).toHaveLength(2);
    expect(cut.join(' ')).toBe(long);
  });

  it('names who was there in the order the article does', () => {
    const persons = [{ name: 'Edward Smith' }, { name: 'Jack Phillips' }, { name: 'Bruce Ismay' }];
    expect(namedInOrder('Ismay reçoit le message que Phillips a transmis au commandant Smith.', persons)).toEqual([2, 1, 0]);
  });

  it('offers the cards of the themes shown, the others only when too few are', () => {
    const cards = [{ id: 'a', category: 'battle' as const }, { id: 'b', category: 'trade' as const }, { id: 'c', category: 'city' as const }, { id: 'd', category: 'person' as const }];
    expect(byThemes(cards, ['trade', 'settlement']).map((c) => c.id)).toEqual(['b', 'c']);
    expect(byThemes(cards, ['trade']).map((c) => c.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('prefers as detours the places the passage links to', () => {
    const stops = [{ year: 1912 }, { year: 1912 }, { year: 1913 }, { year: 1912 }];
    expect(choiceCandidates(stops, 0, [0], undefined, 5, (i) => (i === 2 ? 2 : 0))).toEqual([2, 1, 3]);
  });

  it('turns as the article tells it: someone a step names who goes on elsewhere, off the walk', () => {
    const stops = [{ year: 1912, when: 1912.27 }, { year: 1912, when: 1912.28 }, { year: 1912, when: 1912.29 }, { year: 1912, when: 1912.3 }, { year: 1920 }];
    const persons = [{ name: 'Edward Smith', born: 1850, died: 1912 }, { name: 'Molly Brown', born: 1867, died: 1932 }, { name: 'Jack Phillips', born: 1887, died: 1912 }];
    const texts = ['Smith commande.', 'Molly Brown embarque à Cherbourg.', 'Smith fait route.', 'Molly Brown prend le canot 6.', 'Molly Brown témoigne.'];
    const sc = { person: 0, steps: [{ stop: 0 }, { stop: 1 }, { stop: 2 }].map((x) => ({ ...x, text: '', cast: [] })) };
    expect(wikiForks(sc, stops, texts, persons)).toEqual([{ at: 1, label: 'Suivre Molly Brown', person: 1, stops: [3, 4] }]);
    // A planned fork following someone the article never places there is dropped; one following no one stays.
    const planned = [{ at: 0, label: 'Suivre Phillips', person: 2, stops: [3] }, { at: 2, label: 'Rester à bord', person: null, stops: [3] }];
    expect(wikiForks({ ...sc, forks: planned }, stops, texts, persons).map((f) => f.label)).toEqual(['Rester à bord', 'Suivre Molly Brown']);
  });

  it('ends a real person’s walk where they died, and follows someone on further in the article without days', () => {
    const stops = [
      { year: 1912, label: 'Port de départ', name: 'Southampton' }, { year: 1912, label: 'Lieu du naufrage', name: 'Naufrage du Titanic' },
      { year: 1912, label: 'Arrivée des rescapés', name: 'New York' }, { year: 1912, label: 'Sauvetage', name: 'RMS Carpathia' },
    ];
    const steps = [0, 1, 2].map((stop) => ({ stop }));
    expect(untilDeath(steps, stops, { died: 1912 })).toEqual([{ stop: 0 }, { stop: 1 }]);
    expect(untilDeath(steps, stops, { died: 1937 })).toEqual(steps);
    expect(untilDeath(steps, stops, undefined)).toEqual(steps);
    const persons = [{ name: 'Edward Smith', born: 1850, died: 1912 }, { name: 'Arthur Rostron', born: 1869, died: 1940 }];
    const texts = ['Smith commande.', 'Rostron reçoit l’appel.', 'Les rescapés arrivent.', 'Rostron recueille les rescapés.'];
    const sc = { person: 0, steps: [{ stop: 0 }, { stop: 1 }].map((x) => ({ ...x, text: '', cast: [] })) };
    expect(wikiForks(sc, stops, texts, persons)).toEqual([{ at: 1, label: 'Suivre Arthur Rostron', person: 1, stops: [3] }]);
  });

  it('finds where a life\'s article tells a moment: the place it links, that year first', () => {
    const wiki = [
      'Né à [[Comber]] en 1873.',
      '== Carrière ==',
      'En 1907, il dirige à [[Belfast]] les plans de l’[[Olympic]].',
      'En 1912, il embarque à [[Southampton]] sur le Titanic.',
      '== Mort ==',
      'Il meurt en 1912 dans le naufrage, au large de [[Terre-Neuve]].',
    ].join('\n');
    const mentions = mentionsOf(wiki);
    expect(momentIn(mentions, ['Southampton'], 1912)?.path[0]).toBe('Carrière');
    expect(momentIn(mentions, ['Atlantique Nord'], 1912)?.target).toBe('Southampton');
    expect(momentIn(mentions, ['Paris'], 1850)).toBeNull();
    expect(headingIn(wiki, 'carrière')).toBe(true);
    expect(headingIn(wiki, 'Comber')).toBe(false);
  });
});
