import { describe, expect, it } from 'vitest';
import { placeLinks } from './entity.ts';

describe('the names of a card’s text', () => {
  it('finds each name linked once, whole words, never overlapping, in the order of the text', () => {
    const text = 'Le Titanic, commandé par Edward Smith, quitte Southampton. Smith meurt ; Southamptonien est un autre mot.';
    expect(placeLinks(text, ['Southampton', 'Edward Smith', 'Smith', 'Belfast'])).toEqual([
      { i: 1, start: 25, end: 37 }, { i: 0, start: 46, end: 57 }, { i: 2, start: 59, end: 64 },
    ]);
  });
});
