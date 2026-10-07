import {
  forkWalk, formatWhen, formatYear, recitOf, threadOf, THREAD_LABELS, type PoiLite, type ScenarioWalk, type Source, type StepChoice, type StepPicture,
  type StepQuote, type StoryPerson, type WalkLead, type WalkStep,
} from '@way/shared';
import type { Entity } from './entity.ts';
import { viaServer } from './media.ts';
import {
  add, clearNext, crochet, emptyQueue, goTo, move, nearSpan, nearWalks, parseQueue, progressOf, remove, start, stepOf, takeShelf, treeOf, updateStep, type Queue,
  type Run,
} from './queue.ts';
import type { StepAround } from './storymap.ts';
import type { TimeMark } from './timeline.ts';

// The scenario's card, on the left: the step told as an article (its
// picture, its place and moment, two or three sentences, then the whole
// section on demand, who was there, the crochets), and at its foot the
// player: the file's steps, "Suivant" step by step. It folds down to its
// player, it never closes by itself: what is clicked on the map opens its own
// card on the right, and both are read side by side. The general timeline
// stays, the file's steps marked on it. The file works like a music player's
// queue (queue.ts): a scenario fills it, a crochet slips a few steps in at its
// head and the file goes on by itself after them, "Bifurquer" sets what comes
// next aside (a route not taken) for another route. Clicking elsewhere only
// gives the camera to the visitor until "Suivant" (or ◎). A step's text is
// written when the visitor gets there, knowing the turns taken; the file is
// kept in this browser.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A crossroads: someone present at the step, or its place. */
export type Lead = { kind: 'person'; person: StoryPerson; hero?: boolean } | { kind: 'place'; poi: PoiLite };

/** Where a crossroads is taken: the step's year and the walk it leaves. */
export interface LeadFrom {
  year: number;
  walk: ScenarioWalk | null;
}

/** Paths through a place or a person, shown above the player ("Chemins qui passent par…"). */
export interface Here {
  /** The card's id or the person's item. */
  key: string;
  title: string;
  walks: ScenarioWalk[];
  /** `pending` while an AI writes them. */
  status: 'ready' | 'pending' | 'none' | 'no-ai';
  person?: StoryPerson;
  poi?: PoiLite;
}

/** Where another route may start from a step: the place across the centuries, or the world at that moment. */
export interface ThreadAt {
  poi: PoiLite | null;
  year: number;
  lat: number;
  lon: number;
}

/** The file, kept in this browser; the paths of the film before it, read once. */
const QUEUE_KEY = 'orbis:queue';
const OLD_PATHS_KEY = 'orbis:paths';
/** Two steps closer than this pass through the same place. */
const SAME_PLACE_KM = 40;
const MAX_FORKS = 3;
const MAX_DECISIONS = 6;
/** Crochets offered on a step; the file's steps marked on the timeline, around the one now, of a few scenarios at most. */
const MAX_CHIPS = 4;
const MARKS_AROUND = 30;
const MARKED_SCENARIOS = 3;
/** Steps of the file shown in the player, around the one now (of its scenario and the one before). */
const PIPS = 9;
/** Steps seen listed in the file's panel. */
const SEEN_SHOWN = 8;

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** The crossroads of a step: the people present (not the protagonist), the protagonist's own life, the place's card. Pure, for tests. */
export function stepLeads(walk: ScenarioWalk, j: number): Lead[] {
  const st = walk.steps[j];
  if (!st) return [];
  const people: Lead[] = st.cast.filter((p) => p.qid !== walk.hero?.qid).slice(0, 2).map((person) => ({ kind: 'person', person }));
  // A card's scenario follows its hero through one story: their whole life is a path of its own.
  if (walk.hero && walk.from && people.length < 2) people.push({ kind: 'person', person: walk.hero, hero: true });
  const place: Lead[] = st.poi && st.poi.id !== walk.from?.id ? [{ kind: 'place', poi: st.poi }] : [];
  return [...people.slice(0, MAX_FORKS - place.length), ...place];
}

/** Paths known that pass through a step's place (not the walk itself). Pure, for tests. */
export function throughPlace(walks: ScenarioWalk[], walk: ScenarioWalk, j: number, limit = 2): ScenarioWalk[] {
  const st = walk.steps[j];
  if (!st) return [];
  return walks
    .filter((w) => w.id !== walk.id && w.steps.some((s) => (st.poi && s.poi?.id === st.poi.id) || km(s, st) < SAME_PLACE_KM))
    .slice(0, limit);
}

/** The turns taken before a step, oldest first: before the walk (a turning point's), then along it. Pure, for tests. */
export function stepDecisions(walk: ScenarioWalk, j: number): string[] {
  const along = walk.steps.slice(0, j).flatMap((s) => (s.chosen !== undefined && s.choices?.[s.chosen] ? [s.choices[s.chosen]!.label] : []));
  return [...(walk.decisions ?? []), ...along].slice(-MAX_DECISIONS);
}

/**
 * A place of the story off the route, taken as a crochet: one step there,
 * written as the walk's own, knowing the steps lived before it. Pure, for tests.
 */
export function choiceWalk(walk: ScenarioWalk, j: number, k: number): ScenarioWalk | null {
  const st = walk.steps[j];
  const c = st?.choices?.[k];
  if (!st || !c?.step) return null;
  const before = walk.steps.slice(0, j + 1);
  return {
    ...walk,
    id: `${walk.id}|crochet|${j}|${k}`,
    title: c.label,
    prelude: [...(walk.prelude ?? []), ...before.flatMap((s) => (s.stop === undefined ? [] : [s.stop]))],
    decisions: [...stepDecisions(walk, j), c.label].slice(-MAX_DECISIONS),
    steps: [{ ...c.step }],
  };
}

/** A place's card as a walk of one step, to be added to the file. */
export function cardWalk(poi: PoiLite): ScenarioWalk {
  return {
    id: `card|${poi.id}`,
    title: poi.title,
    premise: `${poi.title}, ajouté à la file depuis sa fiche.`,
    invented: true,
    thread: 'place',
    hero: null,
    from: null,
    source: { url: '', title: poi.title, kind: 'wikipedia' },
    steps: [{ place: poi.title, label: poi.title, year: poi.date_start, lat: poi.lat, lon: poi.lon, poi, text: '', cast: [] }],
  };
}

/** A step's text written, with the people present and the turns the story may take. */
export interface StepText {
  text: string;
  recit: string | null;
  cast: StoryPerson[];
  choices: StepChoice[];
  next: string | null;
  facts: string[];
  quote: StepQuote | null;
  gallery: StepPicture[];
  near: PoiLite[];
  sources: Source[];
  ai: string | null;
}

/** A step's picture as kept: paths remembered before captions kept plain addresses. */
const pictureOf = (g: StepPicture | string): StepPicture => (typeof g === 'string' ? { src: g, caption: null } : g);

/** A step's picture for its thumbnail: its place's, else the first of its gallery. */
const thumbOf = (s: { image?: string | null; gallery?: (StepPicture | string)[] }): string | null =>
  s.image ?? (s.gallery?.[0] ? pictureOf(s.gallery[0]).src : null);

const face = (p: { name: string; image: string | null }) =>
  `<span class="cn-fork-mark">${p.image ? `<img alt="" src="${esc(viaServer(p.image))}" referrerpolicy="no-referrer">` : esc(p.name.charAt(0))}</span>`;

/** "de Napoléon", "d’Edward". */
const of = (name: string) => (/^[aeiouyàâéèêëîïôöùûü]/i.test(name) ? `d’${name}` : `de ${name}`);

/** A picture between a step's paragraphs, with its caption, as an article shows it. */
const figure = (g: StepPicture) => `<figure class="sa-fig">
    <img alt="${esc(g.caption ?? '')}" src="${esc(viaServer(g.src))}" referrerpolicy="no-referrer" loading="lazy">
    ${g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ''}
  </figure>`;

/**
 * A step in full, as a section of an article: its picture at the head, then
 * (in `body`) its paragraphs with the section's pictures between them, a
 * sentence of the article, the facts to keep, who was there, its sources and
 * the AI that wrote it. `writer`: the AI writing it, while it does.
 */
export function stepParts(walk: ScenarioWalk, j: number, writer: string | null): { head: StepPicture | null; body: string } {
  const st = walk.steps[j];
  if (!st) return { head: null, body: '' };
  const pics = (st.gallery ?? []).map(pictureOf);
  const head = st.image ? { src: st.image, caption: null } : pics.shift() ?? null;
  const paragraphs = st.text ? st.text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) : [];
  // Pictures between the paragraphs, as an article shows them (never after the last); the others in a strip.
  const slots = [0, 2].filter((k) => k < paragraphs.length - 1).slice(0, pics.length);
  const inline = pics.slice(0, slots.length);
  const strip = pics.slice(slots.length);
  const quote = st.quote
    ? `<blockquote class="sa-quote">« ${esc(st.quote.text)} »<cite><a href="${esc(st.quote.source.url)}" target="_blank" rel="noopener">${esc(st.quote.source.title)}</a></cite></blockquote>`
    : '';
  const quoteAt = paragraphs.length > 2 ? 1 : paragraphs.length - 1;
  const article = paragraphs.length
    ? `<div class="sa-article">${paragraphs.map((t, k) => {
      const at = slots.indexOf(k);
      return `<p class="sa-par">${esc(t)}</p>${at >= 0 ? figure(inline[at]!) : ''}${k === quoteAt ? quote : ''}`;
    }).join('')}</div>`
    : `<div class="sa-writing"><span class="sc-note-dot" aria-hidden="true"></span>${writer ? esc(writer) : 'L’IA'} écrit cette étape d’après l’article de Wikipédia sur ${esc(st.place)}…</div>
      <div class="skeleton-lines"><i></i><i></i><i></i><i></i><i></i></div>`;
  const facts = st.facts?.length
    ? `<aside class="sa-facts"><div class="sa-box-title">Repères</div><ul>${st.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></aside>`
    : '';
  const who = st.text && st.cast.length
    ? `<section class="sa-who"><div class="sa-box-title">Présents</div><div class="sa-who-list">${st.cast.map((c, k) => `<button type="button" class="sa-person" data-act="who" data-i="${k}" title="${esc(`${c.name} · ${c.role}`)}" aria-haspopup="menu">
        ${face(c)}<span class="sa-person-text"><b>${esc(c.name)}</b><small>${esc(c.role)}</small></span></button>`).join('')}</div></section>`
    : '';
  const pictures = strip.length
    ? `<div class="sa-gallery">${strip.map((g, k) => `<button type="button" class="sa-pic" data-act="pic" data-url="${esc(viaServer(g.src))}" data-caption="${esc(g.caption ?? '')}" aria-label="${esc(g.caption ?? `Image ${k + 1}`)}" title="${esc(g.caption ?? '')}"><img alt="" src="${esc(viaServer(g.src))}" referrerpolicy="no-referrer" loading="lazy"></button>`).join('')}</div>`
    : '';
  const sources = st.sources?.length ? st.sources : st.text ? [walk.source] : [];
  const credit = st.ai
    ? `Texte rédigé par <b>${esc(st.ai)}</b> d’après ${sources.length > 1 ? 'ces articles' : 'cet article'} de Wikipédia (CC BY-SA) : vérifiez-les.`
    : st.text ? 'Texte écrit avec le chemin, d’après l’article ci-dessus.' : '';
  const footer = sources.length
    ? `<footer class="sa-sources"><div class="sa-box-title">Sources</div>
        <ul>${sources.filter((s) => s.url).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title.replace(/^Wikipédia : /, ''))}</a></li>`).join('')}</ul>
        <p class="sa-ai">${credit}${walk.ai ? ` Chemin tracé par ${esc(walk.ai)}.` : ''}</p></footer>`
    : '';
  return { head, body: `${article}${facts}${who}${pictures}${footer}` };
}

/**
 * In the scenario's card, in place of the step: the file, the routes to take
 * instead, a place's or person's paths, the ways on at the end, the tree of
 * the scenarios taken.
 */
type Panel = 'queue' | 'routes' | 'here' | 'suites' | 'tree';

/** The scenario's card: open, folded down to its player, or put away (a button brings the file back). */
type View = 'open' | 'folded' | 'closed';

/** The step now, with its walk and its item in the file. */
type Playing = NonNullable<ReturnType<typeof stepOf>>;

/** A small tree: a trunk and its branches, drawn in the ink of the buttons. */
const TREE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 15V3M8 9 4 5.5M8 7l4-3M4 5.5V3M12 4V2"/><circle cx="8" cy="2.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="2.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="1.8" r="1.1" fill="currentColor" stroke="none"/></svg>';

/** The step's section in full under its récit: left open, it stays open from step to step. */
const ARTICLE_KEY = 'orbis:article';

export class Player {
  private q: Queue = emptyQueue();
  /** Clicked elsewhere: the file waits where it is, the camera is the visitor's (the card stays as it is). */
  private paused = true;
  private view: View = 'open';
  private article = (() => {
    try {
      return localStorage.getItem(ARTICLE_KEY) === '1';
    } catch {
      return false;
    }
  })();
  /** What the card's body shows, to keep where it was read when it is drawn again. */
  private shownKey = '';
  /** Scenarios turned off in the filters. */
  private enabled = true;
  private panel: Panel | null = null;
  private here: Here | null = null;
  /** Something being prepared (a crochet, a life written by an AI). */
  private note: string | null = null;
  /** The AI writing the step now, while it does. */
  private writer: string | null = null;
  /** What the buttons shown point to. */
  private leads: Lead[] = [];
  private walksShown: ScenarioWalk[] = [];
  private afterShown: WalkLead[] = [];

  /** A step to show: map, timeline, its card and its people go there; `first`: the file started or taken up again. */
  onStep: (walk: ScenarioWalk, step: number, first: boolean) => void = () => undefined;
  /** The step now and those beside it in the file, to draw on the globe. */
  onRoute: (now: WalkStep, prev: StepAround | null, next: StepAround | null) => void = () => undefined;
  /** The scenario's pin on the map: the step now, played or paused (null: none, or scenarios off). */
  onPin: (step: WalkStep | null, label: string, paused: boolean) => void = () => undefined;
  /** A step without its text: to be written. */
  onNeedText: (walk: ScenarioWalk, step: number) => void = () => undefined;
  /** Paused (or nothing plays any more): the people of the step leave the map. */
  onPause: () => void = () => undefined;
  /** The step now, its text or the state changed (the cards of the places mark it). */
  onChange: () => void = () => undefined;
  /** The file's steps around the one now, to mark on the general timeline (none when nothing is in it). */
  onMarks: (marks: TimeMark[]) => void = () => undefined;
  /** A card to open (from the paths of a place). */
  onOpenCard: (poi: PoiLite) => void = () => undefined;
  /** A crossroads taken: a crochet around the step's year, or the whole path as another route. */
  onLead: (lead: Lead, how: 'detour' | 'full', at: LeadFrom) => void = () => undefined;
  /** Another route from a step: its place across the centuries, or the world at its moment. */
  onThread: (kind: 'place' | 'era', at: ThreadAt) => void = () => undefined;
  /** A walk met: remembered for the search bar. */
  onMet: (walk: ScenarioWalk) => void = () => undefined;
  /** A name to act on (someone present at the step): its menu opens under it. */
  onEntity: (anchor: HTMLElement, e: Entity) => void = () => undefined;

  constructor(private root: HTMLElement, private known: () => ScenarioWalk[]) {
    this.q = this.load();
    root.addEventListener('click', (e) => this.click(e));
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Escape' && this.panel) this.closePanel();
      // Before the card and the timeline: while the file plays, the arrows are the player's.
      else if (this.playingNow && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) this.go(e.key === 'ArrowRight' ? 1 : -1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    this.render();
  }

  private get playingNow(): boolean {
    return this.enabled && !this.paused && !!stepOf(this.q, this.q.at);
  }

  /** The step now (played or paused). */
  get playing(): { walk: ScenarioWalk; step: number } | null {
    const s = this.enabled ? stepOf(this.q, this.q.at) : null;
    return s && { walk: s.walk, step: s.item.step };
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The step now's place in the file, as numbered on the frieze ("4", "b"). */
  get number(): string {
    return this.q.items[this.q.at] ? this.label(this.q.at) : '';
  }

  /** The item now, to know whether the visitor moved on while a crochet was written. */
  get cursor(): string | null {
    return this.q.items[this.q.at]?.key ?? null;
  }

  /** The step after the one now, for its text to be written ahead. */
  get upcoming(): { walk: ScenarioWalk; step: number } | null {
    const s = stepOf(this.q, this.q.at + 1);
    return s && { walk: s.walk, step: s.item.step };
  }

  /** How far the visitor read a walk, for the cards. */
  progressOf(id: string): { step: number; done: boolean } | undefined {
    return progressOf(this.q, id);
  }

  /** Where a card's place comes in the file, if it does: the next time first, else the latest. */
  placeIn(poiId: string): { i: number; n: string; now: boolean } | null {
    const at = (i: number) => stepOf(this.q, i)?.step.poi?.id === poiId;
    let i = this.q.items.findIndex((_, k) => k >= this.q.at && at(k));
    if (i < 0) i = this.q.items.map((_, k) => k).reverse().find(at) ?? -1;
    return i >= 0 ? { i, n: this.label(i), now: i === this.q.at } : null;
  }

  /** A walk taken (a scenario, a life, another route): what came next is set aside, its steps come next, from `from`. */
  start(walk: ScenarioWalk, from = 0): void {
    this.q = start(this.q, walk, from);
    this.onMet(walk);
    this.play(true);
  }

  /** A crochet written: slipped in after the step now; gone to if the visitor is still where they asked it (`asked`). */
  crochet(walk: ScenarioWalk, asked: string | null): void {
    const go = !this.paused && asked === this.cursor;
    this.q = crochet(this.q, walk, go);
    this.onMet(walk);
    if (go) this.play(false);
    else this.commit();
  }

  /** A place added from its card: right after the step now (the file itself when empty, waiting). */
  add(poi: PoiLite): void {
    const empty = !stepOf(this.q, this.q.at);
    this.q = add(this.q, cardWalk(poi));
    if (this.view === 'closed') this.view = 'folded';
    if (empty) this.paused = true;
    this.commit();
  }

  /** A step of the file chosen (in the player, on the timeline, the panel, a card): the scenario's card shows it. */
  goTo(i: number): void {
    if (!this.q.items[i]) return;
    const first = this.paused;
    this.q = goTo(this.q, i);
    if (this.view === 'closed') this.view = 'open';
    this.play(first);
  }

  /** "Lire l'étape" (on a place's card): the scenario's card opens on the step now. */
  unfold(): void {
    this.view = 'open';
    this.panel = null;
    this.render();
  }

  /** Clicked elsewhere on the globe: the file waits where it is, the camera is the visitor's; with none played, the panel closes. */
  pause(): void {
    if (!this.playingNow) {
      if (this.panel) this.closePanel();
      return;
    }
    this.paused = true;
    this.panel = null;
    this.onPause();
    this.commit();
  }

  resume(): void {
    if (stepOf(this.q, this.q.at)) this.play(true);
  }

  /** Scenarios turned off or on: off, the player goes, the file stays. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (!on && this.playingNow) this.onPause();
    this.enabled = on;
    this.paused = true;
    this.panel = null;
    this.note = null;
    this.here = null;
    this.commit();
  }

  /** The paths through a place or a person, in the scenario's card. */
  showHere(here: Here): void {
    this.here = here;
    this.view = 'open';
    this.openPanel('here');
  }

  /** New paths for the place or person shown (written meanwhile). */
  updateHere(here: Here): void {
    if (this.here?.key !== here.key) return;
    this.here = here;
    if (this.panel === 'here') this.render();
  }

  get hereKey(): string | null {
    return this.here?.key ?? null;
  }

  /** A step beside the one now, chosen on the globe: the one before, or the next. */
  showStep(side: -1 | 1): void {
    this.go(side);
  }

  /** The scenario's pin clicked: its card opens on the step now, the camera goes back to it. */
  back(): void {
    if (stepOf(this.q, this.q.at)) this.goTo(this.q.at);
  }

  /** Drawn again (a place's card opened or closed beside it). */
  refresh(): void {
    this.render();
  }

  /** What is being prepared ("L'IA écrit un crochet…"), or null. */
  setNote(text: string | null): void {
    this.note = text;
    this.render();
  }

  /** The AI writing the step now (null once done). */
  setWriter(ai: string | null): void {
    if (ai === this.writer) return;
    this.writer = ai;
    this.render();
    this.onChange();
  }

  get writing(): string | null {
    return this.writer;
  }

  /** A step's text has come: kept with the file (it is not written twice). */
  setStepText(walkId: string, j: number, t: StepText): void {
    const st = this.q.walks[walkId]?.steps[j];
    if (!st) return;
    this.writer = null;
    this.q = updateStep(this.q, walkId, j, {
      ...st, text: t.text, recit: t.recit, cast: t.cast.length ? t.cast : st.cast, choices: t.choices, next: t.next, facts: t.facts, quote: t.quote,
      gallery: t.gallery, near: t.near, sources: t.sources, ai: t.ai,
    });
    this.onMet(this.q.walks[walkId]!);
    this.commit();
  }

  private load(): Queue {
    try {
      const saved = localStorage.getItem(QUEUE_KEY);
      if (saved) return parseQueue(JSON.parse(saved));
      // The film's paths: the latest one not finished becomes the file, where it was.
      const old = JSON.parse(localStorage.getItem(OLD_PATHS_KEY) ?? '[]') as { walk: ScenarioWalk; step: number; done: boolean; at: number }[];
      const last = Array.isArray(old) ? old.filter((p) => p?.walk?.steps?.length && !p.done).sort((a, b) => b.at - a.at)[0] : undefined;
      return last ? start(emptyQueue(), last.walk, Math.min(last.step, last.walk.steps.length - 1)) : emptyQueue();
    } catch {
      return emptyQueue();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.q));
    } catch {
      /* not remembered */
    }
  }

  /** Changed: kept, drawn, said. */
  private commit(): void {
    this.save();
    this.render();
    this.onChange();
  }

  private openPanel(p: Panel): void {
    this.panel = p;
    this.render();
  }

  private closePanel(): void {
    this.panel = null;
    this.render();
  }

  /** The step now shown: laid out first (the map flies to the part the player leaves visible), then written if it is not. */
  private play(first: boolean): void {
    const s = stepOf(this.q, this.q.at);
    if (!s) return this.commit();
    this.paused = false;
    if (this.view === 'closed') this.view = 'open';
    if (this.panel !== 'queue') this.panel = null;
    this.note = null;
    this.writer = null;
    this.save();
    this.render();
    this.onStep(s.walk, s.item.step, first);
    if (!s.step.ai) this.onNeedText(s.walk, s.item.step);
    this.onChange();
  }

  private go(delta: number): void {
    if (this.q.items[this.q.at + delta]) this.goTo(this.q.at + delta);
  }

  /** A turning point taken: another route, what came next set aside. */
  private takeFork(walk: ScenarioWalk, j: number, k: number): void {
    const w = forkWalk(walk, j, k);
    if (w) this.start(w);
  }

  /**
   * A crochet taken from the step now: a place of the story is one step
   * slipped in; someone met, or another card, a few steps written there.
   */
  private choose(k: number): void {
    const s = stepOf(this.q, this.q.at);
    const c = s?.step.choices?.[k];
    if (!s || !c) return;
    this.q = updateStep(this.q, s.walk.id, s.item.step, { ...s.step, chosen: k });
    const walk = this.q.walks[s.walk.id]!;
    if (c.poi || c.person) {
      this.save();
      this.onLead(c.person ? { kind: 'person', person: c.person } : { kind: 'place', poi: c.poi! }, 'detour', { year: s.step.year, walk });
      return;
    }
    const w = choiceWalk(walk, s.item.step, k);
    if (w) this.crochet(w, this.cursor);
  }

  /** "Terminer", or the card put away: the scenario's card goes, the file stays (a button brings it back). */
  private finish(): void {
    this.paused = true;
    this.view = 'closed';
    this.panel = null;
    this.onPause();
    this.commit();
  }

  private click(e: MouseEvent): void {
    const b = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!b || !this.root.contains(b)) return;
    const s = stepOf(this.q, this.q.at);
    const n = Number(b.dataset.i);
    const from = (): LeadFrom => ({ year: s?.step.year ?? 0, walk: s?.walk ?? null });
    switch (b.dataset.act) {
      case 'panel': {
        const p = b.dataset.view as Panel;
        return this.panel === p ? this.closePanel() : this.openPanel(p);
      }
      case 'close-panel': return this.closePanel();
      case 'resume': return this.resume();
      case 'fold':
        this.view = 'folded';
        this.panel = null;
        return this.render();
      case 'unfold': return this.unfold();
      case 'close': return this.finish();
      case 'article':
        this.article = !this.article;
        try {
          localStorage.setItem(ARTICLE_KEY, this.article ? '1' : '0');
        } catch {
          /* not remembered */
        }
        return this.render();
      case 'pic': {
        // A picture of the section takes the head's place.
        const img = this.root.querySelector<HTMLImageElement>('.sc-img img');
        if (img && b.dataset.url) img.src = b.dataset.url;
        const caption = this.root.querySelector<HTMLElement>('.sc-img-caption');
        if (caption) {
          caption.textContent = b.dataset.caption ?? '';
          caption.hidden = !b.dataset.caption;
        }
        this.root.querySelectorAll('.sa-pic').forEach((x) => x.classList.toggle('on', x === b));
        return;
      }
      case 'prev': return this.go(-1);
      case 'next': return this.go(1);
      case 'goto': return this.goTo(n);
      case 'fork':
        if (s) this.takeFork(s.walk, s.item.step, n);
        return;
      case 'choice': return this.choose(n);
      case 'retry':
        if (s) this.onNeedText(s.walk, s.item.step);
        return;
      case 'lead': {
        const lead = this.leads[n];
        if (lead) this.onLead(lead, b.dataset.how as 'detour' | 'full', from());
        return;
      }
      case 'thread':
        if (s) this.onThread(b.dataset.kind as 'place' | 'era', { poi: s.step.poi, year: s.step.year, lat: s.step.lat, lon: s.step.lon });
        return;
      case 'who': {
        const person = s?.step.cast[n];
        if (person) this.onEntity(b, { kind: 'person', person });
        return;
      }
      case 'up':
      case 'down':
        this.q = move(this.q, b.dataset.key!, b.dataset.act === 'up' ? -1 : 1);
        return this.commit();
      case 'remove':
        this.q = remove(this.q, b.dataset.key!);
        return this.commit();
      case 'clear':
        this.q = clearNext(this.q);
        return this.commit();
      case 'shelf':
        this.q = takeShelf(this.q, n);
        return this.play(this.paused);
      case 'finish': return this.finish();
      case 'walk': {
        const w = this.walksShown[n];
        if (!w) return;
        const p = this.progressOf(w.id);
        this.start(w, p && !p.done ? p.step : 0);
        return;
      }
      case 'after-paths': {
        const l = this.afterShown[n];
        if (l) this.onLead({ kind: 'place', poi: l.poi }, 'full', { year: l.year, walk: s?.walk ?? null });
        return;
      }
      case 'card': {
        const poi = b.dataset.after !== undefined ? this.afterShown[Number(b.dataset.after)]?.poi : this.here?.poi;
        if (poi) this.onOpenCard(poi);
        return;
      }
      case 'life':
        if (this.here?.person) this.onLead({ kind: 'person', person: this.here.person }, b.dataset.how as 'detour' | 'full', from());
        return;
    }
  }

  /** An item as numbered on the frieze: its step in its walk, a letter in a crochet, "+" when added. */
  private label(i: number): string {
    const it = this.q.items[i];
    if (!it) return '';
    if (it.added) return '+';
    if (!it.crochet) return String(it.step + 1);
    let k = 0;
    while (i - k - 1 >= 0 && this.q.items[i - k - 1]?.crochet === it.crochet) k++;
    return String.fromCharCode(97 + (k % 26));
  }

  private render(): void {
    const s = this.enabled ? stepOf(this.q, this.q.at) : null;
    const playing = !!s && !this.paused;
    document.body.classList.toggle('scenario-on', playing);
    const note = this.note ? `<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>${esc(this.note)}</div>` : '';
    const panel = this.panel && this.enabled ? this.panelView(this.panel) : '';
    // Open whenever a panel shows; folded down to its player; put away, a button brings the file back.
    const state = panel || (s && this.view === 'open') ? 'open' : s && this.view === 'folded' ? 'folded' : s ? 'closed' : note ? 'note' : 'none';
    let html = '';
    if (state === 'open') {
      html = `<section class="sc-card${s?.item.crochet ? ' in-crochet' : ''}" aria-label="Le scénario">
          ${this.head(s)}
          <div class="sc-body">${note}${panel || (s ? this.stepView(s) : '')}</div>
          ${s ? this.foot(s, true) : ''}
        </section>`;
    } else if (state === 'folded') {
      html = `<section class="sc-card folded${s!.item.crochet ? ' in-crochet' : ''}" aria-label="Le lecteur">${note}${this.foot(s!, false)}</section>`;
    } else if (state === 'closed') {
      html = `${note ? `<div class="sc-alone">${note}</div>` : ''}<button type="button" class="sc-launch" data-act="unfold" title="Le scénario et sa file">☰ Ma file <span class="cn-count">${this.q.items.length - this.q.at}</span></button>`;
    } else if (state === 'note') html = `<div class="sc-alone">${note}</div>`;
    document.body.classList.toggle('sc-open', state === 'open');
    document.body.classList.toggle('sc-folded', state === 'folded');
    // Drawn again on the same step (its text came, a note): it stays where it was read.
    const key = `${state}|${this.panel ?? ''}|${this.q.items[this.q.at]?.key ?? ''}`;
    const scroll = key === this.shownKey ? this.root.querySelector('.sc-body')?.scrollTop ?? 0 : 0;
    this.shownKey = key;
    this.root.hidden = state === 'none';
    this.root.className = `scenario-root ${state}`;
    this.root.innerHTML = html;
    const body = this.root.querySelector('.sc-body');
    if (body) body.scrollTop = scroll;
    this.root.querySelectorAll<HTMLImageElement>('img').forEach((img) => img.addEventListener('error', () => {
      const head = img.closest('.sc-img');
      if (head) head.classList.add('no-img');
      else img.closest('figure')?.remove();
      img.remove();
    }));
    this.onMarks(s ? this.marks() : []);
    this.onPin(s?.step ?? null, s ? this.label(this.q.at) : '', !playing);
    if (playing) this.route();
  }

  /** The step now on the globe, with the one before it and the next (nothing more: the routes are in the card). */
  private route(): void {
    const at = this.q.at;
    const beside = (i: number): StepAround | null => {
      const t = stepOf(this.q, i);
      return t && { step: t.step, label: this.label(i) };
    };
    this.onRoute(stepOf(this.q, at)!.step, beside(at - 1), beside(at + 1));
  }

  /** The file's steps around the one now, for the general timeline: those of the few scenarios nearest it. */
  private marks(): TimeMark[] {
    const from = Math.max(0, this.q.at - MARKS_AROUND);
    const to = Math.min(this.q.items.length, this.q.at + MARKS_AROUND + 1);
    const walks = nearWalks(this.q, MARKED_SCENARIOS);
    return this.q.items.slice(from, to).flatMap((it, k) => {
      const i = from + k;
      if (!walks.has(it.walk)) return [];
      const t = stepOf(this.q, i)!.step;
      const state: TimeMark['state'] = i === this.q.at ? 'now' : i < this.q.at ? 'done' : 'todo';
      return [{ i, year: t.when ?? t.year, state, crochet: !!it.crochet, title: `${this.label(i)}. ${t.place} · ${formatWhen(t)}` }];
    });
  }

  /** The card's head: what the file follows; ✕ puts it away (the file stays). */
  private head(s: Playing | null): string {
    const close = s
      ? '<button type="button" class="sc-icon" data-act="close" title="Ranger le scénario (la file reste)" aria-label="Ranger le scénario">✕</button>'
      : '<button type="button" class="sc-icon" data-act="close-panel" title="Fermer (Échap)" aria-label="Fermer">✕</button>';
    if (!s) return `<header class="sc-head"><div class="sc-head-text"><span class="sc-head-title">Scénarios</span></div>${close}</header>`;
    const { walk, item } = s;
    return `<header class="sc-head">
        <div class="sc-head-text">
          <span class="pl-thread">${item.crochet ? '↪ Crochet' : THREAD_LABELS[threadOf(walk)]}${walk.hero ? ` · ${esc(walk.hero.name)}` : ''}</span>
          <span class="sc-head-title" title="${esc(walk.premise)}">${esc(walk.title)}</span>
        </div>
        ${close}
      </header>`;
  }

  /**
   * The step as an article: its picture, its place and moment, the récit
   * (two or three sentences), then the whole section on demand; the crochets
   * and "Bifurquer" under it.
   */
  private stepView(s: Playing): string {
    const { walk, step: st, item } = s;
    const j = item.step;
    this.leads = stepLeads(walk, j);
    const { head, body } = stepParts(walk, j, this.writer);
    const sources = st.sources?.length ? st.sources : st.text ? [walk.source] : [];
    const recit = st.text
      ? `<p class="sc-recit">${esc(recitOf(st))}</p>`
      : `<div class="pl-writing"><span class="sc-note-dot" aria-hidden="true"></span>${this.writer ? esc(this.writer) : 'L’IA'} écrit cette étape d’après Wikipédia… <button type="button" class="sc-link" data-act="retry">relancer</button></div>
        <div class="skeleton-lines"><i></i><i></i></div>`;
    const who = st.text && st.cast.length
      ? `Présents : ${st.cast.slice(0, 4).map((c, k) => `<button type="button" class="pl-who" data-act="who" data-i="${k}" aria-haspopup="menu" title="${esc(c.role)}">${esc(c.name)}</button>`).join(', ')}`
      : '';
    const credit = [who, sources[0] ? `d’après ${esc(sources[0].title)}` : '', st.ai ? `rédigé par ${esc(st.ai)}` : ''].filter(Boolean).join(' · ');
    const paragraphs = st.text ? st.text.split(/\n\s*\n/).filter((x) => x.trim()).length : 0;
    const parts = [`${paragraphs} paragraphe${paragraphs > 1 ? 's' : ''}`, st.facts?.length ? 'repères' : '', st.cast.length ? 'présents' : '', 'sources']
      .filter(Boolean).join(' · ');
    const article = st.text
      ? `<button type="button" class="sc-article-toggle" data-act="article" aria-expanded="${this.article}">
          <span class="sc-article-text"><b>${this.article ? 'Replier l’article' : 'Lire l’article'}</b><small>${esc(parts)}</small></span><span class="sc-chev" aria-hidden="true"></span>
        </button>
        ${this.article ? `<div class="sc-article">${body}</div>` : ''}`
      : '';
    const chips = this.chips(walk, j);
    return `<figure class="sa-img sc-img${head ? '' : ' no-img'}">${head ? `<img alt="" src="${esc(viaServer(head.src))}" referrerpolicy="no-referrer">` : ''}</figure>
      <p class="sa-img-caption sc-img-caption"${head?.caption ? '' : ' hidden'}>${esc(head?.caption ?? '')}</p>
      <div class="sc-title"><h2 class="sc-place">${esc(st.place)}</h2><span class="sc-when">${esc(formatWhen(st))} · ${esc(st.beat ?? st.label)}</span></div>
      ${recit}
      ${credit ? `<div class="pl-meta">${credit}</div>` : ''}
      ${article}
      <div class="sc-label">${chips ? 'Faire un crochet, ou bifurquer' : 'Une autre route'}</div>
      <div class="pl-chips">
        ${chips}
        <button type="button" class="pl-chip${this.panel === 'routes' ? ' on' : ''}" data-act="panel" data-view="routes" title="Une autre route : la suite est mise de côté">⑂ Bifurquer</button>
      </div>`;
  }

  /**
   * The player, at the card's foot: the steps of the scenario read and of the
   * one before it, around the step now (☰ the whole file, the tree of the
   * scenarios taken), back, "Suivant", fold. Folded, the step's name above it
   * and a way to read it again.
   */
  private foot(s: Playing, open: boolean): string {
    const { walk, step: st, item } = s;
    const n = this.q.items.length;
    const at = this.q.at;
    const next = stepOf(this.q, at + 1);
    const inCrochet = !!item.crochet;
    const span = nearSpan(this.q);
    const from = Math.max(span.from, Math.min(at - 3, span.to - PIPS));
    const to = Math.min(span.to, from + PIPS);
    const pips = Array.from({ length: to - from }, (_, k) => {
      const i = from + k;
      const it = this.q.items[i]!;
      const t = stepOf(this.q, i)!.step;
      const state = i === at ? 'now' : i < at ? 'done' : 'todo';
      const pip = `<button type="button" class="sc-pip ${state}${it.crochet ? ' cr' : ''}${it.added ? ' added' : ''}" data-act="goto" data-i="${i}" title="${esc(`${this.label(i)}. ${t.place} · ${formatWhen(t)}`)}" aria-label="${esc(`Étape ${this.label(i)}, ${t.place}, ${formatWhen(t)}`)}"${i === at ? ' aria-current="step"' : ''}><span>${esc(this.label(i))}</span></button>`;
      return k ? `<i class="sc-line${i <= at ? '' : ' next'}"></i>${pip}` : pip;
    }).join('');
    const crochetNext = !!next?.item.crochet && next.item.crochet !== item.crochet;
    const go = next
      ? `<button type="button" class="pl-next${crochetNext ? ' crochet' : ''}" data-act="next" title="L’étape suivante (→)">
          <span>${crochetNext ? 'Suivant · crochet' : inCrochet && !next.item.crochet ? 'Suivant · la file reprend' : `Suivant · ${at + 2} / ${n}`}<small>${esc(next.step.place)}, ${esc(formatWhen(next.step))}${st.next && next.walk.id === walk.id ? ` — ${esc(st.next)}` : ''}</small></span>
          <span aria-hidden="true">→</span>
        </button>`
      : `<button type="button" class="pl-next end" data-act="panel" data-view="suites" title="Ce qui peut suivre : des personnes, des suites, d’autres chemins">
          <span>Fin de la file<small>Et ensuite ? des personnes, des suites, d’autres chemins</small></span><span aria-hidden="true">▸</span>
        </button>`;
    const mini = open ? '' : `<div class="sc-mini">
        <span class="sc-mini-text"><b>${esc(st.place)}</b> · ${esc(formatWhen(st))} · ${esc(walk.title)}</span>
        <button type="button" class="sc-btn" data-act="unfold" title="La fiche du scénario, sur l’étape en cours">▴ Lire l’étape</button>
      </div>`;
    return `<div class="sc-player">
        ${mini}
        <div class="sc-pips-row">
          ${from > 0 ? '<span class="sc-more" aria-hidden="true">…</span>' : ''}
          <div class="sc-pips" role="group" aria-label="La file, étape ${at + 1} sur ${n}">${pips}</div>
          ${to < span.to ? '<span class="sc-more" aria-hidden="true">…</span>' : ''}
          ${this.paused ? '<button type="button" class="sc-icon" data-act="resume" title="Revenir à l’étape : la caméra y retourne" aria-label="Revenir à l’étape">◎</button>' : ''}
          <button type="button" class="sc-icon sc-tree-btn${this.panel === 'tree' ? ' on' : ''}" data-act="panel" data-view="tree" title="L’arbre des scénarios pris, comme dans un carnet" aria-label="L’arbre des scénarios">${TREE_ICON}</button>
          <button type="button" class="sc-icon${this.panel === 'queue' ? ' on' : ''}" data-act="panel" data-view="queue" title="La file et l’historique" aria-label="La file et l’historique">☰</button>
        </div>
        <div class="pl-nav">
          <button type="button" class="pl-ctl" data-act="prev" ${at === 0 ? 'disabled' : ''} aria-label="Étape précédente" title="Étape précédente (←)">⏮</button>
          ${go}
          ${open ? '<button type="button" class="pl-ctl" data-act="fold" aria-label="Replier la fiche du scénario" title="Replier la fiche : le lecteur reste">▾</button>' : ''}
        </div>
      </div>`;
  }

  /** The crochets offered on the step: its detours (once written), then the people present not offered yet. */
  private chips(walk: ScenarioWalk, j: number): string {
    const st = walk.steps[j]!;
    const followed = new Set((st.forks ?? []).flatMap((f) => (f.hero ? [f.hero.qid] : [])));
    const choices = st.text ? (st.choices ?? []).flatMap((c, k) => (c.person && followed.has(c.person.qid) ? [] : [`<button type="button" class="pl-chip cr${st.chosen === k ? ' on' : ''}" data-act="choice" data-i="${k}" title="Un crochet : ${c.person ? 'quelques moments de sa vie' : c.poi ? `un pas par ${esc(c.poi.title)}` : `${esc(c.step?.place ?? '')}, une étape`}, puis la file reprend">↪ ${esc(c.label)}</button>`])) : [];
    const asked = new Set((st.choices ?? []).flatMap((c) => (c.person ? [c.person.qid] : [])));
    const people = this.leads.flatMap((l, i) => (l.kind === 'person' && !l.hero && !asked.has(l.person.qid) && !followed.has(l.person.qid)
      ? [`<button type="button" class="pl-chip cr" data-act="lead" data-i="${i}" data-how="detour" title="Quelques moments de sa vie autour de celui-ci, puis la file reprend">↪ ${esc(l.person.name)}</button>`]
      : []));
    return [...choices, ...people].slice(0, MAX_CHIPS).join('');
  }

  /** A panel in the card's body, in place of the step (✕ goes back to it). */
  private panelView(p: Panel): string {
    const body = p === 'here' && this.here ? this.hereView(this.here)
      : p === 'routes' ? this.routesView()
      : p === 'suites' ? this.suites()
      : p === 'tree' ? this.treeView()
      : this.queueView();
    const back = !!stepOf(this.q, this.q.at);
    const name = { queue: 'La file', routes: 'Bifurquer', suites: 'Et ensuite', tree: 'L’arbre des scénarios', here: 'Chemins' }[p];
    return `<section class="pl-panel" aria-label="${name}">
        ${back ? '<button type="button" class="sc-icon pl-panel-close" data-act="close-panel" title="Revenir à l’étape (Échap)" aria-label="Revenir à l’étape">✕</button>' : ''}
        ${body}
      </section>`;
  }

  /** The file: seen, now, next (crochets grouped, each movable and removable), the routes set aside. */
  private queueView(): string {
    const q = this.q;
    const row = (i: number, cls: string, tools: boolean) => {
      const it = q.items[i]!;
      const t = stepOf(q, i)!.step;
      return `<div class="pl-row ${cls}">
          <button type="button" class="pl-row-main" data-act="goto" data-i="${i}" title="${esc(stepOf(q, i)!.walk.title)}">
            <span class="pl-n">${esc(this.label(i))}</span><span class="pl-row-place">${esc(t.place)}</span><span class="pl-row-when">${esc(formatWhen(t))}</span>
          </button>
          ${tools ? `<button type="button" class="pl-tool" data-act="up" data-key="${esc(it.key)}" aria-label="Monter ${esc(t.place)}" title="Plus tôt">↑</button><button type="button" class="pl-tool" data-act="down" data-key="${esc(it.key)}" aria-label="Descendre ${esc(t.place)}" title="Plus tard">↓</button><button type="button" class="pl-tool" data-act="remove" data-key="${esc(it.key)}" aria-label="Retirer ${esc(t.place)}" title="Retirer">×</button>` : ''}
        </div>`;
    };
    if (q.at < 0) return '<div class="cn-kicker">La file</div><p class="cn-empty">Rien dans la file. Ouvrez une fiche : « Partir sur un fil » propose ses parcours, « + À la file » y ajoute le lieu.</p>';
    const seenFrom = Math.max(0, q.at - SEEN_SHOWN);
    const seen = Array.from({ length: q.at - seenFrom }, (_, k) => row(seenFrom + k, 'seen', false)).join('');
    let next = '';
    for (let i = q.at + 1; i < q.items.length; i++) {
      const it = q.items[i]!;
      if (it.crochet && q.items[i - 1]?.crochet !== it.crochet) {
        const group: string[] = [];
        let k = i;
        while (q.items[k]?.crochet === it.crochet) group.push(row(k++, 'cr', false));
        const w = q.walks[it.crochet];
        next += `<div class="pl-group">
            <div class="pl-group-head"><span>↪ Crochet · ${esc(w?.title ?? '')}</span><button type="button" class="pl-tool" data-act="remove" data-key="${esc(it.key)}" aria-label="Retirer ce crochet" title="Retirer ce crochet">×</button></div>
            ${group.join('')}
            <div class="pl-group-foot">puis la file reprend d’elle-même</div>
          </div>`;
        i = k - 1;
      } else next += row(i, it.added ? 'added' : 'next', true);
    }
    const shelf = q.shelf.map((sh, k) => `<div class="pl-shelf">
        <span class="pl-shelf-text"><b>⑂ ${esc(sh.title)}</b><small>mise de côté à ${esc(sh.from)} · ${sh.items.length} étape${sh.items.length > 1 ? 's' : ''}</small></span>
        <button type="button" class="cn-go" data-act="shelf" data-i="${k}">Prendre cette route</button>
      </div>`).join('');
    return `<div class="cn-kicker">La file <span class="cn-aside">· gardée dans ce navigateur</span></div>
      ${seen ? `<div class="pl-label pl-sec">Déjà vu</div>${seen}` : ''}
      <div class="pl-label pl-sec now">Maintenant</div>${row(q.at, 'now', false)}
      <div class="pl-label pl-sec">À suivre</div>${next || '<p class="cn-empty">Rien ensuite.</p>'}
      ${shelf ? `<div class="pl-label pl-sec">Routes non prises</div>${shelf}<p class="pl-hint">« Bifurquer » remplace la suite ; l’ancienne suite est rangée ici.</p>` : ''}
      ${next ? '<footer class="sc-foot"><button type="button" class="sc-link" data-act="clear">Vider la suite</button></footer>' : ''}`;
  }

  /**
   * The scenarios taken, as a tree in a notebook: the trunk goes down from
   * the first, a crochet branches off and comes back, a route set aside hangs
   * off where it was left (it may be taken again). A click goes there.
   */
  private treeView(): string {
    const q = this.q;
    const stems = treeOf(q);
    if (!stems.length) return '<div class="cn-kicker">L’arbre des scénarios</div><p class="cn-empty">Rien encore : prenez un parcours sur une fiche, l’arbre poussera avec vos choix.</p>';
    const node = (r: Run, cls: string, mark: string) => {
      const w = q.walks[r.walk];
      const first = stepOf(q, r.from)!.step;
      const last = stepOf(q, r.to - 1)!.step;
      const state = r.to <= q.at ? 'done' : r.from > q.at ? 'todo' : 'now';
      const n = r.to - r.from;
      const where = first.place === last.place ? first.place : `${first.place} → ${last.place}`;
      const when = formatYear(first.year) === formatYear(last.year) ? formatYear(first.year) : `${formatYear(first.year)} – ${formatYear(last.year)}`;
      const kind = r.crochet ? 'crochet' : w ? THREAD_LABELS[threadOf(w)] : '';
      return `<button type="button" class="tr-node ${cls} ${state}" data-act="goto" data-i="${state === 'now' ? q.at : r.from}" title="${esc(w?.premise ?? '')}">
          <span class="tr-dot" aria-hidden="true">${mark}</span>
          <span class="tr-text"><b>${esc(w?.title ?? '')}</b><small>${esc([kind, `${n} étape${n > 1 ? 's' : ''}`, where, when].filter(Boolean).join(' · '))}</small>
          ${state === 'now' ? `<em class="tr-here">vous êtes ici · ${esc(stepOf(q, q.at)!.step.place)}</em>` : ''}</span>
        </button>`;
    };
    const rows = stems.map((st, k) => {
      const shelves = st.shelves.map((i) => {
        const sh = q.shelf[i]!;
        return `<li class="tr-branch shelf"><button type="button" class="tr-node shelf" data-act="shelf" data-i="${i}" title="Prendre cette route : la suite actuelle est mise de côté à son tour">
            <span class="tr-dot" aria-hidden="true">⑂</span>
            <span class="tr-text"><b>${esc(sh.title)}</b><small>route non prise · laissée à ${esc(sh.from)} · ${sh.items.length} étape${sh.items.length > 1 ? 's' : ''}</small></span>
          </button></li>`;
      }).join('');
      const crochets = st.crochets.map((r) => `<li class="tr-branch crochet">${node(r, 'crochet', '↪')}</li>`).join('');
      const turn = st.turn ? `<div class="tr-turn">⑂ bifurcation</div>` : k && !st.turn ? '<div class="tr-turn quiet">la file reprend</div>' : '';
      return `<li class="tr-stem">${turn}${node(st.run, 'main', st.turn || !k ? '●' : '·')}${crochets || shelves ? `<ul class="tr-branches">${crochets}${shelves}</ul>` : ''}</li>`;
    }).join('');
    return `<div class="cn-kicker">L’arbre des scénarios <span class="cn-aside">· gardé dans ce navigateur</span></div>
      <div class="tr-carnet">
        <div class="tr-head">Carnet de route</div>
        <ol class="tr-trunk">${rows}</ol>
        <p class="tr-legend"><span>● un chemin pris</span><span>↪ un crochet, qui revient</span><span>⑂ une route laissée</span></p>
      </div>`;
  }

  /** "Bifurquer": another route from the step now, one way: what comes next is set aside. */
  private routesView(): string {
    const s = stepOf(this.q, this.q.at);
    if (!s) return '<p class="cn-empty">Rien ne joue.</p>';
    const { walk, step: st } = s;
    this.leads = stepLeads(walk, s.item.step);
    const row = (act: string, icon: string, title: string, sub: string, extra = '') =>
      `<button type="button" class="cross-fork" data-act="${act}" ${extra}><span class="cross-icon" aria-hidden="true">${icon}</span><span class="cross-text"><b>${title}</b><small>${sub}</small></span></button>`;
    const forks = (st.forks ?? []).map((f, k) => `<button type="button" class="cross-fork" data-act="fork" data-i="${k}">
        ${f.hero ? face(f.hero) : '<span class="cross-icon" aria-hidden="true">⑂</span>'}
        <span class="cross-text"><b>${esc(f.label)}</b><small>${f.hero ? `avec ${esc(f.hero.name)} · ` : ''}${f.steps[0] ? `${esc(f.steps[0].place)} · ${esc(formatWhen(f.steps[0]))}` : ''}</small></span>
      </button>`).join('');
    const lives = this.leads.map((l, i) => (l.kind === 'person'
      ? `<button type="button" class="cross-fork" data-act="lead" data-i="${i}" data-how="full">${face(l.person)}<span class="cross-text"><b>Toute la vie ${esc(of(l.person.name))}</b><small>${l.hero ? 'le personnage de ce chemin' : esc(l.person.role)}</small></span></button>`
      : '')).join('');
    const thread = threadOf(walk);
    const place = st.poi && thread !== 'place' ? row('thread', '⌛', 'Rester ici à travers les siècles', `${esc(st.poi.title)}, d’époque en époque`, 'data-kind="place"') : '';
    const era = thread !== 'era' ? row('thread', '◍', `Le monde vers ${esc(formatYear(st.year))}`, 'une époque, plusieurs thèmes', 'data-kind="era"') : '';
    return `<div class="cn-kicker">⑂ Bifurquer <span class="cn-aside">· la suite est mise de côté, et reste dans la file</span></div>
      <h2 class="cn-title">Depuis ${esc(st.place)}</h2>
      <div class="pl-routes">${forks}${lives}${place}${era}</div>`;
  }

  /** The end of the file: ways on, never a dead end. */
  private suites(): string {
    const s = stepOf(this.q, this.q.at);
    if (!s) return '<p class="cn-empty">Rien ne joue.</p>';
    const { walk, step: st } = s;
    this.leads = stepLeads(walk, s.item.step);
    this.afterShown = walk.after ?? [];
    this.walksShown = throughPlace(this.mergedKnown(), walk, s.item.step);
    const after = this.afterShown.map((l, i) => `<div class="cn-fork">
        <span class="cn-fork-mark cn-place" aria-hidden="true">⏩</span>
        <span class="cn-fork-text"><b>${esc(l.poi.title)}</b><small>${esc(`${l.label} · ${formatYear(l.year)}`)}</small></span>
        <button type="button" class="cn-go" data-act="after-paths" data-i="${i}">Ses chemins</button>
        <button type="button" class="cn-go" data-act="card" data-after="${i}">La fiche</button>
      </div>`).join('');
    const people = this.leads.map((l, i) => (l.kind === 'person' ? `<div class="cn-fork">
        ${face(l.person)}
        <span class="cn-fork-text"><b>${esc(l.person.name)}</b><small>${esc(l.hero ? 'Le personnage de ce chemin' : l.person.role)}</small></span>
        <button type="button" class="cn-go" data-act="lead" data-i="${i}" data-how="full">Tout son chemin</button>
      </div>` : '')).join('');
    const others = this.walksShown.map((w, i) => this.walkRow(w, i)).join('');
    const shelf = this.q.shelf.length ? '<button type="button" class="sc-btn cn-back" data-act="panel" data-view="queue">⑂ Reprendre une route mise de côté</button>' : '';
    return `<div class="cn-kicker">Fin de la file</div>
      <h2 class="cn-title">Et ensuite ?</h2>
      ${shelf}
      ${people ? `<section class="cn-forks"><div class="cn-forks-title">Suivre un personnage</div>${people}</section>` : ''}
      ${after ? `<section class="cn-forks"><div class="cn-forks-title">Ce que ça a engendré</div>${after}</section>` : ''}
      ${others ? `<section class="cn-forks"><div class="cn-forks-title">D’autres chemins par ${esc(st.place)}</div>${others}</section>` : ''}
      <footer class="sc-foot"><button type="button" class="sc-link cn-finish" data-act="finish">Terminer et ranger le lecteur ✓</button></footer>`;
  }

  /** Walks known: met on cards and searches, and those of the file. */
  private mergedKnown(): ScenarioWalk[] {
    const out = new Map<string, ScenarioWalk>(Object.entries(this.q.walks));
    for (const w of this.known()) if (!out.has(w.id)) out.set(w.id, w);
    return [...out.values()];
  }

  /** A walk offered: read it (what comes next is set aside), or take it up where it was left. */
  private walkRow(w: ScenarioWalk, i: number): string {
    const p = this.progressOf(w.id);
    const now = stepOf(this.q, this.q.at)?.walk.id === w.id;
    const go = now ? 'En cours ●' : p && !p.done ? `Reprendre · étape ${p.step + 1} ▸` : p?.done ? 'Relire ↺' : 'Lire ▸';
    const who = `${THREAD_LABELS[threadOf(w)]}${w.hero ? ` · ${esc(w.hero.name)}` : ''}`;
    return `<div class="cn-walk${now ? ' playing' : ''}">
        <div class="cn-walk-badges"><span class="story-sc-kind ${w.invented ? 'invented' : 'real'}">${who}</span><span class="story-sc-len">${w.steps.length} étapes${w.from ? ` · ${esc(w.from.title)}` : ''}</span></div>
        <div class="cn-walk-title">${esc(w.title)}</div>
        <div class="cn-walk-premise">${esc(w.premise)}</div>
        <div class="cn-walk-acts">
          <button type="button" class="sc-btn sc-primary" data-act="walk" data-i="${i}" ${now ? 'disabled' : ''} title="${stepOf(this.q, this.q.at) ? 'La suite de la file est mise de côté' : ''}">${go}</button>
        </div>
      </div>`;
  }

  private hereView(h: Here): string {
    this.leads = [];
    this.afterShown = [];
    this.walksShown = h.walks;
    const s = stepOf(this.q, this.q.at);
    const year = s?.step.year;
    const life = h.person
      ? `<div class="cn-fork cn-life">
          ${face(h.person)}
          <span class="cn-fork-text"><b>Suivre la vie de ${esc(h.person.name)}</b><small>Étape par étape, à travers les fiches de sa vie</small></span>
          ${s && year !== undefined ? `<button type="button" class="cn-go cn-crochet" data-act="life" data-how="detour" title="Quelques étapes de sa vie autour de ${esc(formatYear(year))}, puis la file reprend">↪ Un crochet (${esc(formatYear(year))})</button>` : ''}
          <button type="button" class="cn-go cn-go-main" data-act="life" data-how="full">Toute sa vie ▸</button>
        </div>`
      : '';
    const state = h.status === 'pending' ? `<div class="sc-note"><span class="sc-note-dot" aria-hidden="true"></span>${h.walks.length ? 'L’IA écrit d’autres chemins…' : 'L’IA trace les chemins qui passent ici…'}</div>`
      : h.status === 'no-ai' && !h.walks.length ? '<p class="cn-empty">Aucune IA disponible pour tracer des chemins pour le moment.</p>'
      : !h.walks.length && !h.person ? '<p class="cn-empty">Aucun chemin ne passe encore par ici.</p>'
      : '';
    return `
      <div class="cn-kicker">Chemins qui passent par</div>
      <h2 class="cn-title">${esc(h.title)}</h2>
      ${life}
      <div class="cn-walks">${h.walks.map((w, i) => this.walkRow(w, i)).join('')}</div>
      ${state}
      ${h.poi ? '<footer class="sc-foot"><button type="button" class="sc-link" data-act="card">Explorer sa fiche et tous ses lieux ⤷</button></footer>' : ''}`;
  }
}


/** Scenarios met so far, for the search bar (kept in this browser only). */
const LIBRARY_KEY = 'orbis:scenarios';
const LIBRARY_MAX = 40;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export class ScenarioLibrary {
  private walks: ScenarioWalk[] = [];

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]') as ScenarioWalk[];
      if (Array.isArray(raw)) this.walks = raw.filter((w) => w && typeof w.id === 'string' && Array.isArray(w.steps));
    } catch {
      /* storage unavailable: the library starts empty */
    }
  }

  get all(): ScenarioWalk[] {
    return this.walks;
  }

  /** Remembers scenarios shown on a card or written for a person (the latest first); a place added alone is no scenario. */
  add(walks: ScenarioWalk[]): void {
    const kept = walks.filter((w) => !w.id.startsWith('card|'));
    if (!kept.length) return;
    const ids = new Set(kept.map((w) => w.id));
    this.walks = [...kept, ...this.walks.filter((w) => !ids.has(w.id))].slice(0, LIBRARY_MAX);
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.walks));
    } catch {
      /* not remembered */
    }
  }

  /** Scenarios whose title, premise, person, card or places name every word asked. */
  search(q: string, limit = 5): ScenarioWalk[] {
    const words = fold(q).split(/\s+/).filter((w) => w.length >= 2);
    if (!words.length) return [];
    return this.walks.filter((w) => {
      const text = fold([w.title, w.premise, w.hero?.name ?? '', w.from?.title ?? '', ...w.steps.map((s) => s.place)].join(' '));
      return words.every((x) => text.includes(x));
    }).slice(0, limit);
  }

  /** Scenarios passing through a card (written on it, or with a step there), or following a person. */
  through(at: { poi?: PoiLite; qid?: string }): ScenarioWalk[] {
    return this.walks.filter((w) => at.poi
      ? w.from?.id === at.poi.id || w.steps.some((s) => s.poi?.id === at.poi!.id || km(s, at.poi!) < SAME_PLACE_KM / 4)
      : w.hero?.qid === at.qid || w.steps.some((s) => s.cast.some((c) => c.qid === at.qid)));
  }
}
