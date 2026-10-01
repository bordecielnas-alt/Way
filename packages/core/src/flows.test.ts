import { describe, expect, it } from 'vitest';
import type { FlowDef } from '@way/shared';
import { buildStages, ExtractedStages } from './flows.ts';

const plague: FlowDef = { id: 'black-death', kind: 'epidemic', title: 'Peste noire', start: 1346, end: 1353, articles: [] };
const article = 'The plague reached Caffa in 1346. Genoese ships carried it to Messina in October 1347. From Messina it spread to Marseille in 1348.';
const stage = (place: string, year: number, from: string | null, quote: string) =>
  ({ place, modern_place: `${place}, X`, year, from, note: 'arrivée de la peste', quote });
const at = { lat: 45, lon: 10 };

describe('flows', () => {
  it('keeps quoted stages within the flow\'s time, linked to where they came from', () => {
    const s = buildStages(plague, article, [
      { stage: stage('Messina', 1347, 'Caffa', 'Genoese ships carried it to Messina in October 1347'), at },
      { stage: stage('Caffa', 1346, null, 'The plague reached Caffa in 1346'), at },
      { stage: stage('Marseille', 1348, 'Messina', 'From Messina it spread to Marseille in 1348'), at },
    ]);
    expect(s.map((x) => [x.place, x.from])).toEqual([['Caffa', null], ['Messina', 0], ['Marseille', 1]]);
    expect(s[0]!.note).toBe('Arrivée de la peste');
  });

  it('drops invented quotes, dates out of time, unlocated places and repeats', () => {
    const s = buildStages(plague, article, [
      { stage: stage('Caffa', 1346, null, 'The plague reached Caffa in 1346'), at },
      { stage: stage('Paris', 1348, 'Caffa', 'Paris lost half of its people in 1348'), at }, // not in the article
      { stage: stage('Messina', 1200, null, 'Genoese ships carried it to Messina'), at }, // long before
      { stage: stage('Marseille', 1348, 'Nowhere', 'From Messina it spread to Marseille in 1348'), at: null }, // not found on the map
      { stage: stage('Caffa', 1350, null, 'The plague reached Caffa in 1346'), at }, // already there
    ]);
    expect(s.map((x) => x.place)).toEqual(['Caffa']);
  });

  it('tolerates malformed stages in the AI answer', () => {
    expect(ExtractedStages.parse({ stages: [{ place: 'x' }, stage('Caffa', 1346, null, 'The plague reached Caffa')] }).stages.filter(Boolean)).toHaveLength(1);
    expect(ExtractedStages.parse({ stages: 'none' }).stages).toEqual([]);
  });
});
