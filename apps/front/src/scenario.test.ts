import { describe, expect, it } from 'vitest';
import type { PoiLite, ScenarioWalk, StoryPerson, WalkStep } from '@way/shared';
import { routeOptions, stepDecisions, stepLeads, throughPlace } from './scenario.ts';

const person = (qid: string, name: string): StoryPerson => ({ qid, name, role: 'Rôle', born: 1850, died: 1912, image: null });
const card = (id: string, title: string) => ({ id, title }) as PoiLite;
const step = (place: string, lat: number, lon: number, poi: PoiLite | null, cast: StoryPerson[] = []): WalkStep =>
  ({ place, label: 'Escale', year: 1912, lat, lon, poi, text: '…', cast });
const walk = (id: string, steps: WalkStep[], extra: Partial<ScenarioWalk> = {}): ScenarioWalk => ({
  id, title: id, premise: 'Vous êtes…', invented: false, hero: null, steps,
  source: { url: 'u', title: 't', kind: 'wikipedia' }, from: card('titanic', 'Titanic'), ...extra,
});

describe('crossroads of the carnet', () => {
  const smith = person('Q1', 'Edward Smith');
  const andrews = person('Q2', 'Thomas Andrews');
  const murdoch = person('Q3', 'William Murdoch');

  it('offers the people present, then the protagonist’s whole life, then the place’s own card', () => {
    const w = walk('a', [step('Southampton', 50.9, -1.4, card('soton', 'Southampton'), [smith, andrews])], { hero: smith });
    const leads = stepLeads(w, 0);
    expect(leads.map((l) => (l.kind === 'person' ? l.person.name : l.poi.title))).toEqual(['Thomas Andrews', 'Edward Smith', 'Southampton']);
    expect(leads[1]).toMatchObject({ hero: true });
  });

  it('keeps three crossroads at most, and none for the card the walk was written on', () => {
    const w = walk('a', [step('Titanic', 41.7, -49.9, card('titanic', 'Titanic'), [andrews, murdoch, person('Q4', 'Autre')])], { hero: smith });
    const leads = stepLeads(w, 0);
    expect(leads).toHaveLength(2);
    expect(leads.every((l) => l.kind === 'person' && !l.hero)).toBe(true);
    // A life crosses cards: its protagonist is no crossroads of their own.
    expect(stepLeads({ ...w, from: null, steps: [step('Comber', 54.5, -5.7, null, [smith])] }, 0)).toEqual([]);
  });

  it('finds other paths through the same place: the same card, or a step close by', () => {
    const here = walk('a', [step('New York', 40.71, -74.0, card('ny', 'New York'))]);
    const sameCard = walk('b', [step('Manhattan', 40.78, -73.97, card('ny', 'New York'))]);
    const near = walk('c', [step('Ellis Island', 40.7, -74.04, null)]);
    const far = walk('d', [step('Boston', 42.36, -71.06, null)]);
    expect(throughPlace([here, sameCard, near, far], here, 0).map((w) => w.id)).toEqual(['b', 'c']);
  });
});

describe('where a step may lead', () => {
  const cobh = step('Cobh', 51.85, -8.3, null);
  const wreck = step('Naufrage', 41.7, -49.9, null);
  const carpathia = step('Carpathia', 41.5, -50.1, null);

  it('draws the way on, the turning points and the detours to a place, not those to someone', () => {
    const at: WalkStep = {
      ...step('Southampton', 50.9, -1.4, null),
      forks: [{ label: 'Rester à terre', hero: null, steps: [carpathia] }, { label: 'Vide', hero: null, steps: [] }],
      choices: [{ label: 'Monter à la radio', person: person('Q5', 'Jack Phillips') }, { label: 'Faire escale à Cobh', step: cobh }],
    };
    const w = walk('a', [at, wreck]);
    expect(routeOptions(w, 0).map((o) => [o.key, o.kind, o.label])).toEqual([
      ['next', 'next', 'Naufrage'], ['fork:0', 'fork', 'Rester à terre'], ['choice:1', 'detour', 'Cobh'],
    ]);
    // The last step goes nowhere planned.
    expect(routeOptions(w, 1)).toEqual([]);
  });

  it('tells the writer the turns taken: before a turning point’s walk, then along it', () => {
    const taken: WalkStep = { ...cobh, choices: [{ label: 'Faire escale à Cobh', step: cobh }], chosen: 0 };
    const w = walk('b', [taken, cobh, wreck], { decisions: ['Monter dans le canot 6'] });
    expect(stepDecisions(w, 0)).toEqual(['Monter dans le canot 6']);
    expect(stepDecisions(w, 2)).toEqual(['Monter dans le canot 6', 'Faire escale à Cobh']);
  });
});
