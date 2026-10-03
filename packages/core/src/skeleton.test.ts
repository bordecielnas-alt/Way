import { describe, expect, it } from 'vitest';
import { bestMention, cleanWikitext, isPlace, labelOf, mentionsOf, phaseOf, rankMentions, yearsIn } from './skeleton.ts';

const ARTICLE = `{{Infobox Navire
 | nom = RMS ''Titanic''
 | chantier = [[Harland and Wolff]], [[Belfast]]
 | lancement = {{date|31 mai 1911}}
}}
Le '''Titanic''' est un paquebot qui fait naufrage en 1912 lors de son [[Naufrage du Titanic|voyage inaugural]].<ref>Une source [[Wikipédia]].</ref>
[[Fichier:Titanic.jpg|vignette|Le navire à [[Southampton]].]]
== Histoire ==
=== Construction ===
Sa construction débute en 1909 à [[Belfast]]. Il est lancé le {{date|31 mai 1911}}.
=== Traversée inaugurale ===
Le {{date|10 avril 1912}}, il quitte [[Southampton]] pour [[New York]]. Il fait escale à [[Cobh|Queenstown]].
== Postérité ==
L'[[Épave du Titanic|épave]] est découverte en 1985 par [[Robert Ballard]].
== Voir aussi ==
* [[Olympic (paquebot)]]
`;

describe('the bones of a story, from the article’s links', () => {
  it('reads dates and units as text, and drops references, files and other templates', () => {
    const text = cleanWikitext(ARTICLE);
    expect(text).toContain('lancé le 31 mai 1911');
    expect(text).toContain('@@chantier@@ [[Harland and Wolff]], [[Belfast]]');
    expect(text).not.toContain('Une source');
    expect(text).not.toContain('vignette');
  });

  it('gathers each link with its headings, its sentence and the year it gives, skipping “Voir aussi”', () => {
    const ms = mentionsOf(ARTICLE);
    const of = (t: string) => ms.filter((m) => m.target === t);
    expect(of('Harland and Wolff')[0]).toMatchObject({ field: 'chantier', path: [] });
    expect(of('Naufrage du Titanic')[0]).toMatchObject({ path: [], year: 1912 });
    expect(of('Southampton')).toHaveLength(1); // not the file's caption
    expect(of('Southampton')[0]).toMatchObject({ path: ['Traversée inaugurale', 'Histoire'], year: 1912 });
    // A sentence without a year takes the paragraph's year before it.
    expect(of('Cobh')[0]).toMatchObject({ year: 1912, sentence: 'Il fait escale à Queenstown.' });
    expect(of('Robert Ballard')[0]!.year).toBe(1985);
    expect(of('Olympic (paquebot)')).toEqual([]);
  });

  it('phases a place by its headings, else by its year against the subject’s dates', () => {
    const subject = { start: 1909, end: 1912 };
    const ms = mentionsOf(ARTICLE);
    const phase = (t: string) => phaseOf(ms.find((m) => m.target === t && (m.path.length || m.field))!, subject);
    expect(phase('Harland and Wolff')).toBe('before'); // the infobox's shipyard
    expect(phase('Southampton')).toBe('during');
    expect(phase('Épave du Titanic')).toBe('after');
    expect(phaseOf({ path: [], field: null, year: 1985 }, subject)).toBe('after');
  });

  it('ranks the places linked most, earliest, and of a precise kind first', () => {
    expect(rankMentions(mentionsOf(ARTICLE))[0]!.target).toBe('Belfast'); // twice, in the infobox and in its section
    // An event outranks a town linked as often.
    const ranked = rankMentions(mentionsOf(ARTICLE), (t) => (t === 'Naufrage du Titanic' ? 'event' : t === 'New York' ? 'city' : null));
    expect(ranked[0]!.target).toBe('Naufrage du Titanic');
    expect(ranked.findIndex((c) => c.target === 'New York')).toBeLessThan(ranked.findIndex((c) => c.target === 'Cobh'));
  });

  it('labels a place by the mention in its own section rather than the introduction', () => {
    const belfast = mentionsOf(ARTICLE).filter((m) => m.target === 'Belfast');
    const m = bestMention(belfast, (y) => y > 1800);
    expect(labelOf(m)).toBe('Construction');
    expect(m.year).toBe(1909);
    expect(labelOf({ path: [], field: 'chantier' })).toBe('Chantier');
  });

  it('reads years, not days, sizes or counts', () => {
    expect(yearsIn('Le 14 avril 1912, à 23 h 40')).toEqual([1912]);
    expect(yearsIn('fondée en 732 par Charles Martel')).toEqual([732]);
    expect(yearsIn('vers 52 av. J.-C.')).toEqual([-52]);
    expect(yearsIn('il emporte 2224 personnes sur 1500 m')).toEqual([]);
  });

  it('keeps points to travel to, not countries, seas or wide regions', () => {
    expect(isPlace({ lat: 50.9, lon: -1.4, type: 'city', dim: null })).toBe(true);
    expect(isPlace({ lat: 46, lon: 2, type: 'country', dim: null })).toBe(false);
    expect(isPlace({ lat: 41, lon: -40, type: 'waterbody', dim: null })).toBe(false);
    expect(isPlace({ lat: 49, lon: 0, type: null, dim: 400_000 })).toBe(false);
    expect(isPlace({ lat: null, lon: null, type: null, dim: null })).toBe(false); // a person, a concept
  });
});
