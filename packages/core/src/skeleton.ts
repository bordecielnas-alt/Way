import { histToAstro, type StoryPhase } from '@way/shared';

// The bones of a card's story, straight from its Wikipedia article, no AI:
// every article it links to, with the section it is linked from and the
// sentence that links it (the year said there, the part it plays). Linked
// articles with coordinates are the places of the story, the others may be
// its people. Read in seconds; an AI only labels them afterwards.

/** One link of the article: where, and in which words. */
export interface Mention {
  /** The linked article's title, as written ("Southampton", "Naufrage du Titanic"). */
  target: string;
  /** The heading it falls under, deepest first ([] in the introduction). */
  path: string[];
  /** The infobox field it fills ("chantier"), when in the infobox. */
  field: string | null;
  sentence: string;
  /** The whole paragraph around it, as text. */
  paragraph: string;
  /** The first year the sentence gives, else the last one of the paragraph before it. */
  year: number | null;
  /** Every year the sentence gives, in order. */
  years: number[];
  /** Order of appearance in the article. */
  order: number;
}

/** Sections whose links are no part of the story: sources, other works, culture. */
const SKIP = /^(notes?|r[ée]f[ée]rences?|voir aussi|bibliographie|liens? externes?|articles? connexes|sources?|annexes?|galerie|see also|references|notes and references|further reading|external links|bibliography|filmographie|documentaires?|dans les arts|dans la culture|culture populaire|in popular culture|romans?|bandes? dessin[ée]es?|po[ée]sie|musique|th[ée][âa]tre|jeux? vid[ée]o|t[ée]l[ée]vision|cin[ée]ma)/i;
/** Inline templates that read as text: their unnamed parameters, in order. */
const TEXT_TEMPLATES = /^(date|date-|dat|unit[ée]|nombre|formatnum|citation|lang|langue|nobr|nowrap|s|s-|-s|siècle|sp|heure|abr[ée]viation|abbr|japonais|ill|lien|small|nobold|centré|ier|er|e|re|1er|1re|mini|nb|x|année|an|start date|death date|birth date|convert|cvt)$/i;
const NAMESPACE = /^(fichier|file|image|cat[ée]gorie|category|wikip[ée]dia|wikipedia|portail|portal|mod[èe]le|template|aide|help|sp[ée]cial|special|wikt|wiktionary|w|commons|s|q|n|v|b|[a-z]{2,3}(-[a-z]+)?):/i;
const ORDINAL = new Set(['er', 'e', 're', 'ier', '1er', '1re']);

/** Split at `|` outside [[links]] and {{templates}}. */
function params(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; cur += two; i++; continue; }
    if ((two === ']]' || two === '}}') && depth > 0) { depth--; cur += two; i++; continue; }
    if (inner[i] === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += inner[i];
  }
  out.push(cur);
  return out;
}

/** A template as text: an infobox as one line per field, a date or a unit as its words, the rest nothing. */
function templateText(inner: string): string {
  const [rawName = '', ...rest] = params(inner);
  const name = rawName.trim().replace(/_/g, ' ');
  if (/^infobox/i.test(name)) {
    return `\n${rest.flatMap((p) => {
      const m = p.match(/^\s*([^=\n]{1,40}?)\s*=\s*([\s\S]*)$/);
      return m && m[2]!.trim() ? [`@@${m[1]!.trim()}@@ ${m[2]!.trim().replace(/\n+/g, ' ')}`] : [];
    }).join('\n')}\n`;
  }
  if (ORDINAL.has(name.toLowerCase())) return name;
  if (!TEXT_TEMPLATES.test(name)) return '';
  const positional = rest.filter((p) => !/^\s*[\w -]+\s*=/.test(p)).map((p) => p.trim());
  // {{lang|en|text}}: the language code is no text.
  if (/^(lang|langue)$/i.test(name)) return positional.slice(1).join(' ');
  return positional.join(' ');
}

/** Wikitext as plain lines with their [[links]] kept: references, files, comments, tags and most templates gone. */
export function cleanWikitext(wikitext: string): string {
  let t = wikitext
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<(gallery|math|syntaxhighlight|timeline|score|imagemap)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Templates from the innermost out: a date inside an infobox field is read first.
  for (let i = 0; i < 12 && t.includes('{{'); i++) {
    const next = t.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => templateText(inner));
    if (next === t) break;
    t = next;
  }
  // Files and categories, with the links of their captions.
  let out = '';
  for (let i = 0; i < t.length;) {
    if (t.startsWith('[[', i) && NAMESPACE.test(t.slice(i + 2, i + 40)) && !/^:/.test(t.slice(i + 2))) {
      let depth = 0;
      let j = i;
      for (; j < t.length; j++) {
        if (t.startsWith('[[', j)) { depth++; j++; } else if (t.startsWith(']]', j)) { depth--; j++; if (depth === 0) break; }
      }
      i = j + 1;
      continue;
    }
    out += t[i];
    i++;
  }
  return out
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\[https?:[^\s\]]+\s?([^\]]*)\]/g, '$1');
}

const UNIT_AFTER = /^\s*(m|km|cm|mm|t|tonnes?|kg|%|personnes|passagers|hommes|femmes|enfants|morts|victimes|m[èe]tres|chevaux|n[œo]euds|tjb|€|\$|francs|livres|dollars|habitants|soldats|exemplaires|pages|km\/h|ch|kW|MW)\b/i;

/** The years a text gives, in order: four figures, or fewer after "en", "vers"…, before Christ negative. Pure, for tests. */
export function yearsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:\b(en|an|vers|depuis|dès|jusqu'en|in|by|since|around|of)\s+)?\b(\d{1,4})(\s*(?:av\.?|avant)\s*J\.?-?C\.?|\s*BC\b|\s*BCE\b|\s*apr\.?\s*J\.?-?C\.?)?/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]);
    const after = text.slice((m.index ?? 0) + m[0].length);
    const bc = !!m[3] && /av|BC/i.test(m[3]);
    const four = m[2]!.length === 4 && n >= 1000 && n <= 2099;
    if (!(four || m[1] || bc) || n === 0 || UNIT_AFTER.test(after)) continue;
    // "le 14 avril 1912": 14 is a day, only after a preposition or before Christ.
    out.push(bc ? -n : n);
  }
  return out;
}

/** A paragraph as kept for the writers. */
const PARAGRAPH_CHARS = 1400;
const LINK = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;
const HEADING = /^(={2,6})\s*(.+?)\s*\1\s*$/;

/** Every link of the article's story sections, with its sentence and year. Pure, for tests. */
export function mentionsOf(wikitext: string): Mention[] {
  const lines = cleanWikitext(wikitext).split('\n');
  const out: Mention[] = [];
  const path: { level: number; title: string }[] = [];
  let skipping = 0;
  let order = 0;
  for (const raw of lines) {
    const h = raw.match(HEADING);
    if (h) {
      const level = h[1]!.length;
      while (path.length && path[path.length - 1]!.level >= level) path.pop();
      const title = h[2]!.replace(LINK, (_, a: string, b?: string) => b ?? a).trim();
      path.push({ level, title });
      if (skipping && level <= skipping) skipping = 0;
      if (!skipping && SKIP.test(title)) skipping = level;
      continue;
    }
    if (skipping) continue;
    let line = raw.replace(/^[{|!*#:;]+[-}+]?\s*/, '').trim();
    if (!line) continue;
    const field = line.match(/^@@(.+?)@@\s*/);
    if (field) line = line.slice(field[0].length);
    // The line as text, the links where they fall in it.
    const links: { target: string; at: number }[] = [];
    let text = '';
    let last = 0;
    for (const m of line.matchAll(LINK)) {
      text += line.slice(last, m.index);
      const target = m[1]!.split('#')[0]!.trim().replace(/_/g, ' ');
      if (target && !NAMESPACE.test(target) && !target.startsWith(':')) links.push({ target, at: text.length });
      text += (m[2] ?? m[1]!).trim();
      last = (m.index ?? 0) + m[0].length;
    }
    text += line.slice(last);
    if (!links.length) continue;
    const sentences = [...text.matchAll(/[^.!?]+(?:[.!?]+|$)/g)].map((s) => ({ s: s[0], at: s.index ?? 0 }));
    let before: number | null = null;
    let si = 0;
    for (const l of links) {
      while (si < sentences.length - 1 && sentences[si + 1]!.at <= l.at) {
        before = yearsIn(sentences[si]!.s)[0] ?? before;
        si++;
      }
      const sentence = (sentences[si]?.s ?? text).trim().replace(/\s+/g, ' ').slice(0, 320);
      out.push({
        target: l.target,
        path: path.map((p) => p.title).reverse(),
        field: field ? field[1]! : null,
        sentence,
        paragraph: text.replace(/\s+/g, ' ').trim().slice(0, PARAGRAPH_CHARS),
        year: yearsIn(sentence)[0] ?? before,
        years: yearsIn(sentence),
        order: order++,
      });
    }
  }
  return out;
}

/** What a section of an article holds for a step written there: its text, the articles it links, its pictures, its detailed articles. */
export interface Section {
  text: string;
  /** Linked articles, in the order of the text, once each. */
  links: string[];
  /** Its files, as named ("Titanic leaving Southampton.jpg"). */
  files: string[];
  /** Their captions in the article, by file, as text. */
  captions: Record<string, string>;
  /** {{Article détaillé|…}}: the articles telling this part at length. */
  detailed: string[];
}

const FILE_START = /\[\[\s*(?:fichier|file|image)\s*:/gi;
const GALLERY = /<gallery[^>]*>([\s\S]*?)<\/gallery>/gi;
/** A file link's parameters that lay it out ("vignette", "upright=1.2", "220px"): never its caption. */
const FILE_OPTION = /^(thumb|thumbnail|vignette|miniature|frame|frameless|cadre|sans[_ ]cadre|border|bordure|left|right|center|centre|none|gauche|droite|n[ée]ant|upright|redresse|baseline|middle|top|bottom|sub|super|text-top|text-bottom|\d*x?\d+\s*px|(alt|lien|link|upright|redresse|page|class|lang|langue)\s*=[\s\S]*)$/i;
const CAPTION_CHARS = 200;

/** A caption's wikitext as text: links as their words, no markup. */
function captionText(raw: string): string | null {
  const text = cleanWikitext(raw).replace(LINK, (_, a: string, b?: string) => b ?? a).replace(/\s+/g, ' ').trim();
  return text.length >= 3 ? text.slice(0, CAPTION_CHARS) : null;
}

/** The files a stretch of wikitext shows, as named, with their captions: linked ([[Fichier:…|…|caption]]) or in a gallery. Pure, for tests. */
export function filesOf(raw: string): { file: string; caption: string | null }[] {
  const out: { file: string; caption: string | null }[] = [];
  const add = (name: string, caption: string | null) => {
    const file = name.trim().replace(/_/g, ' ');
    if (PICTURE.test(file) && !out.some((f) => f.file === file)) out.push({ file, caption });
  };
  for (const m of raw.matchAll(FILE_START)) {
    // To the link's own end, past the links of its caption.
    let depth = 0;
    let j = m.index!;
    for (; j < raw.length; j++) {
      if (raw.startsWith('[[', j)) { depth++; j++; } else if (raw.startsWith(']]', j)) { depth--; j++; if (depth === 0) break; }
    }
    const [head = '', ...rest] = params(raw.slice(m.index! + 2, j - 1));
    const caption = [...rest].reverse().find((p) => p.trim() && !FILE_OPTION.test(p.trim()));
    add(head.replace(/^[^:]*:/, ''), caption ? captionText(caption) : null);
  }
  for (const g of raw.matchAll(GALLERY)) {
    for (const l of g[1]!.split('\n')) {
      const [head = '', ...rest] = params(l.replace(/^\s*(?:fichier|file|image)\s*:/i, ''));
      const caption = [...rest].reverse().find((p) => p.trim() && !FILE_OPTION.test(p.trim()));
      add(head, caption ? captionText(caption) : null);
    }
  }
  return out;
}
const DETAILED = /\{\{\s*(?:article d[ée]taill[ée]|article principal|main|main article|d[ée]taill[ée])\s*\|([^{}]+)\}\}/gi;
const PICTURE = /\.(jpe?g|png|webp|tiff?)$/i;

/**
 * The section of an article a heading names (its subsections included), or
 * the introduction for none ("Introduction", an infobox field): its text,
 * links, pictures and detailed articles. Pure, for tests.
 */
export function sectionOf(wikitext: string, heading: string | null): Section {
  const lines = wikitext.split('\n');
  const want = (heading ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const title = (raw: string) => cleanWikitext(raw).replace(LINK, (_, a: string, b?: string) => b ?? a).replace(/\s+/g, ' ').trim().toLowerCase();
  let from = 0;
  let to = lines.findIndex((l) => HEADING.test(l));
  if (to < 0) to = lines.length;
  const at = want ? lines.findIndex((l) => { const h = l.match(HEADING); return !!h && title(h[2]!) === want; }) : -1;
  if (at >= 0) {
    const level = lines[at]!.match(HEADING)![1]!.length;
    from = at + 1;
    to = lines.findIndex((l, i) => i > at && (l.match(HEADING)?.[1]?.length ?? 99) <= level);
    if (to < 0) to = lines.length;
  }
  const raw = lines.slice(from, to).join('\n');
  const shown = filesOf(raw);
  const files = shown.map((f) => f.file);
  const captions = Object.fromEntries(shown.flatMap((f) => (f.caption ? [[f.file, f.caption]] : [])));
  const detailed = [...raw.matchAll(DETAILED)].flatMap((m) => params(m[1]!).filter((p) => !p.includes('=')).map((p) => p.trim())).filter(Boolean);
  const links: string[] = [];
  const text = cleanWikitext(raw).split('\n')
    .filter((l) => !/^@@/.test(l.trim()) && !HEADING.test(l))
    .map((l) => l.replace(/^[{|!*#:;]+[-}+]?\s*/, '').replace(LINK, (_, a: string, b?: string) => {
      const target = a.split('#')[0]!.trim().replace(/_/g, ' ');
      if (target && !NAMESPACE.test(target) && !target.startsWith(':') && !links.includes(target)) links.push(target);
      return (b ?? a).trim();
    }).trim())
    .filter(Boolean).join('\n').replace(/[ \t]+/g, ' ');
  return { text, links, files, captions, detailed };
}

/** The links of an article's introduction (before its first heading), once each: the words linked and the article. Pure, for tests. */
export function leadLinks(wikitext: string): { target: string; label: string }[] {
  const lead = cleanWikitext(wikitext.split(/^==[^=]/m)[0] ?? '');
  const seen = new Set<string>();
  const out: { target: string; label: string }[] = [];
  for (const line of lead.split('\n')) {
    // The infobox's fields are no sentence of the text.
    if (/^@@/.test(line.trim())) continue;
    for (const m of line.matchAll(LINK)) {
      const target = m[1]!.split('#')[0]!.trim().replace(/_/g, ' ');
      const label = (m[2] ?? m[1]!).trim();
      if (!target || NAMESPACE.test(target) || target.startsWith(':') || label.length < 3) continue;
      const key = target.charAt(0).toUpperCase() + target.slice(1);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target: key, label });
    }
  }
  return out;
}

const BEFORE = /(origine|contexte|gen[èe]se|conception|projet|construction|fondation|pr[ée]paration|pr[ée]lude|ant[ée]c[ée]dent|naissance|jeunesse|formation|lancement|armement|essais|background|origin|design|construct|found|prelude|early life|planning|launch)/i;
const AFTER = /(post[ée]rit[ée]|h[ée]ritage|suites?\b|cons[ée]quence|apr[èe]s|enqu[êe]te|comm[ée]mor|m[ée]moire|m[ée]morial|[ée]pave|d[ée]couverte|hommage|r[ée]percussion|bilan|proc[èe]s|reconstruction|tourisme|r[ée]plique|centenaire|legacy|aftermath|investigation|wreck|memorial|consequence|later|trial|rescap|survivor)/i;
const BEFORE_FIELDS = /(chantier|constructeur|architecte|commanditaire|propri[ée]taire|armateur|fondateur|builder|architect|owner|lancement|quille)/i;

/**
 * A mention's phase: its headings, deepest first, else its year against the
 * subject's dates (an infobox's builder is before). Pure, for tests.
 */
export function phaseOf(m: Pick<Mention, 'path' | 'field'> & { year: number | null }, subject: { start: number; end: number }): StoryPhase {
  if (m.field && BEFORE_FIELDS.test(m.field)) return 'before';
  for (const title of m.path) {
    if (AFTER.test(title)) return 'after';
    if (BEFORE.test(title)) return 'before';
  }
  if (m.year !== null) {
    const y = histToAstro(m.year);
    if (y < histToAstro(subject.start)) return 'before';
    if (y > histToAstro(subject.end) + 1) return 'after';
  }
  return 'during';
}

/** Coordinates of these kinds stand for no place to travel to (a country, a sea). */
const VAGUE_TYPES = /^(country|state|adm1st|adm2nd|continent|waterbody|ocean|sea|river|glacier|forest|globe)/i;
/** Wider than this, a place is a region. */
const MAX_DIM_M = 150_000;
const TYPE_WEIGHT: Record<string, number> = { event: 2, landmark: 2, edu: 1.5, railwaystation: 1.5, airport: 1.5, city: 1, isle: 0.5, mountain: 0.5, pass: 0.5 };

/** A linked article as a place of the story: points with coordinates of a travelable kind. Pure, for tests. */
export function isPlace(info: { lat: number | null; lon: number | null; type: string | null; dim: number | null }): boolean {
  if (info.lat === null || info.lon === null) return false;
  if (info.type && VAGUE_TYPES.test(info.type)) return false;
  return info.dim === null || info.dim <= MAX_DIM_M;
}

/** A linked article, all its mentions gathered. */
export interface Candidate {
  target: string;
  mentions: Mention[];
  score: number;
}

/**
 * Mentions gathered per linked article, scored: how often the article
 * links it, how early, in the introduction or infobox, and what kind of
 * place it is (an event or a building over a city). Best first. Pure, for tests.
 */
export function rankMentions(mentions: Mention[], kind: (target: string) => string | null = () => null): Candidate[] {
  const by = new Map<string, Mention[]>();
  for (const m of mentions) {
    const key = m.target.charAt(0).toUpperCase() + m.target.slice(1);
    by.set(key, [...(by.get(key) ?? []), m]);
  }
  const total = Math.max(1, mentions.length);
  return [...by].map(([target, ms]) => {
    const sentences = new Set(ms.map((m) => m.sentence)).size;
    const first = Math.min(...ms.map((m) => m.order));
    const lead = ms.some((m) => m.path.length === 0);
    const type = kind(target);
    const score = 2 * Math.log2(1 + sentences) + (lead ? 1.5 : 0) + (type ? TYPE_WEIGHT[type] ?? 0 : 0) + (1 - first / total);
    return { target, mentions: ms, score };
  }).sort((a, b) => b.score - a.score);
}

/**
 * The mention that says most of a place's part in the story: dated, in a
 * section of the story rather than the introduction's summary, earliest. Pure, for tests.
 */
export function bestMention(ms: Mention[], plausible: (year: number) => boolean): Mention {
  const dated = ms.filter((m) => m.year !== null && plausible(m.year));
  const inSection = (m: Mention) => !m.field && m.path.length > 0;
  return dated.find(inSection) ?? dated.find((m) => !m.field) ?? ms.find(inSection) ?? dated[0] ?? ms[0]!;
}

/** A short label from the heading (or infobox field) a place is linked under: "Traversée inaugurale", "Chantier". Pure, for tests. */
export function labelOf(m: Pick<Mention, 'path' | 'field'>): string {
  const raw = m.field ?? m.path[0] ?? 'Présentation';
  const clean = raw.replace(/\s+/g, ' ').trim();
  const short = clean.length > 40 ? `${clean.slice(0, 38).replace(/\s+\S*$/, '')}…` : clean;
  return short.charAt(0).toUpperCase() + short.slice(1);
}
