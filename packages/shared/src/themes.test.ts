import { describe, expect, it } from 'vitest';
import { cellsForPoint, ringAround } from './geo.ts';
import { CATEGORY_THEME, faithByName, makeShown, roleTags, THEME_CATEGORIES, THEMES, themesOf } from './themes.ts';

describe('themes', () => {
  it('gives every category but people one theme', () => {
    for (const t of THEMES) for (const c of THEME_CATEGORIES[t]) expect(CATEGORY_THEME[c as keyof typeof CATEGORY_THEME]).toBe(t);
    expect(themesOf({ category: 'fortification' })).toEqual(['war']);
    expect(themesOf({ category: 'person', tags: [...roleTags(['religion', 'state']), 'other'] })).toEqual(['religion', 'state']);
    expect(themesOf({ category: 'person' })).toEqual([]);
  });

  it('shows people through their roles', () => {
    const king = { category: 'person' as const, tags: roleTags(['state']) };
    const nobody = { category: 'person' as const, tags: [] };
    const noWar = makeShown({ hiddenThemes: ['war'], hiddenCats: [], people: true });
    expect(noWar({ category: 'battle' })).toBe(false);
    expect(noWar({ category: 'fortification' })).toBe(false);
    expect(noWar({ category: 'city' })).toBe(true);
    expect(noWar(king)).toBe(true);
    expect(makeShown({ hiddenThemes: ['state'], hiddenCats: [], people: true })(king)).toBe(false);
    // Unknown roles: shown while people are.
    expect(makeShown({ hiddenThemes: [...THEMES], hiddenCats: [], people: true })(nobody)).toBe(true);
    expect(makeShown({ hiddenThemes: [], hiddenCats: [], people: false })(king)).toBe(false);
    expect(makeShown({ hiddenThemes: [], hiddenCats: ['monument'], people: true })({ category: 'monument' })).toBe(false);
  });
});

describe('faithByName', () => {
  it('reads a faith in a realm’s name only when it says one', () => {
    expect(faithByName('Abbasid Caliphate')).toBe('islam');
    expect(faithByName('Émirat de Grenade')).toBe('islam');
    expect(faithByName('Sultanate of Delhi')).toBe('islam');
    expect(faithByName('Prince-Bishopric of Liège')).toBe('christianity');
    expect(faithByName('États pontificaux')).toBe('christianity');
    expect(faithByName('Teutonic Order')).toBe('christianity');
    expect(faithByName('Kingdom of France')).toBeNull();
    // A word inside another is no clue.
    expect(faithByName('Papalotla')).toBeNull();
  });
});

describe('ringAround', () => {
  it('returns the cells exactly k steps out', () => {
    const c = cellsForPoint(41.9, 12.5)[5]!;
    expect(ringAround([c], 0)).toEqual([c]);
    expect(ringAround([c], 1)).toHaveLength(6);
    expect(ringAround([c], 2)).toHaveLength(12);
    expect(ringAround([c], 2)).not.toContain(c);
  });
});
