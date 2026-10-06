import {
  bucketStep, DAY, formatDay, formatYear, posToDecimalYear, posToYear, TIMELINE_TICKS, yearToPos, MAX_YEAR, MIN_YEAR,
} from '@way/shared';

export interface TimeWindow { tStart: number; tEnd: number }

/** A step of the scenario's file, marked on the timeline: `i` its place in the file. */
export interface TimeMark {
  i: number;
  year: number;
  state: 'done' | 'now' | 'todo';
  crochet: boolean;
  title: string;
}

const ERAS: { label: string; from: number; to: number }[] = [
  { label: 'Préhistoire', from: MIN_YEAR, to: -3300 },
  { label: 'Antiquité', from: -3300, to: 476 },
  { label: 'Moyen Âge', from: 476, to: 1492 },
  { label: 'Temps modernes', from: 1492, to: 1789 },
  { label: 'Époque contemporaine', from: 1789, to: MAX_YEAR },
];

/**
 * Play mode: how far each step goes (auto = the timeline's own unit at that
 * era), down to a day; the window then shrinks to one step. And seconds
 * between steps.
 */
const PLAY_STEPS: { id: string; years: number; label: string }[] = [
  { id: 'auto', years: 0, label: 'Pas auto' },
  { id: '1d', years: DAY, label: '+1 jour' },
  { id: '1w', years: 7 * DAY, label: '+1 semaine' },
  { id: '1m', years: 1 / 12, label: '+1 mois' },
  ...[1, 5, 10, 25, 50, 100].map((y) => ({ id: `${y}y`, years: y, label: `+${y} an${y > 1 ? 's' : ''}` })),
];
const PLAY_DELAYS = [0.5, 1, 2, 3, 5, 10];
const PLAY_KEY = 'way:play';
/** Transport: back (−3..−1), pause (0), forward (1..3); each notch goes 3 times faster. */
const SPEEDS = [-3, -2, -1, 0, 1, 2, 3] as const;
const SPEED_RATE = [1, 1, 3, 9];
const SPEED_TITLES: Record<number, string> = {
  [-3]: 'Recul très rapide', [-2]: 'Recul rapide', [-1]: 'Recul (←)', 0: 'Pause (↓)',
  1: 'Lecture (→)', 2: 'Avance rapide', 3: 'Avance très rapide',
};
/** Fewer steps than this apart, steps get longer instead (the map keeps up). */
const MIN_INTERVAL_MS = 150;

/** Transport glyphs: triangles pointing the way, as many as the speed. */
function speedIcon(v: number): string {
  if (v === 0) return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';
  const n = Math.abs(v);
  const w = 7 + (n - 1) * 5;
  const tri = Array.from({ length: n }, (_, i) => {
    const x = i * 5;
    return v > 0 ? `<path d="M${x} 2.5v11l7-5.5z"/>` : `<path d="M${x + 7} 2.5v11l-7-5.5z"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} 16" style="width:${(w / 16) * 13}px" aria-hidden="true">${tri}</svg>`;
}
interface PlayPrefs { step: string; delay: number }

function loadPlay(): PlayPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PLAY_KEY) ?? '{}') as { step?: string | number; delay?: number };
    // Older preferences counted steps in years (0 = auto).
    const step = typeof p.step === 'number' ? (p.step > 0 ? `${p.step}y` : 'auto') : p.step;
    return {
      step: PLAY_STEPS.some((x) => x.id === step) ? step! : 'auto',
      delay: PLAY_DELAYS.includes(p.delay ?? -1) ? p.delay! : 2,
    };
  } catch {
    return { step: 'auto', delay: 2 };
  }
}

/** The window can shrink to a day. */
const MIN_YEARS = DAY;
const MAX_WIDTH = 0.45;
/** Drawn width of a window of a few days. */
const THIN_PX = 14;
/** Narrower than this on screen, dragging the window moves it finely. */
const FINE_PX = 24;

/**
 * Fine drag: how far a window of `years` moves for a drag of `dx` pixels:
 * slowly near where it was grabbed (a day for a few pixels), faster further
 * (a year for about 300 pixels with a one-day window).
 */
export function fineShift(dx: number, years: number): number {
  const n = Math.abs(dx) / 8;
  return Math.sign(dx) * years * (n <= 1 ? n : n ** 1.6);
}

/** Width on the scale of `years` around a decimal year. */
function widthAt(center: number, years: number): number {
  return Math.max(1e-9, yearToPos(center + years / 2) - yearToPos(center - years / 2));
}

function tickLabel(y: number): string {
  if (y === 1) return '1';
  return y < 0 ? `${-y} av.` : String(y);
}

/**
 * Non-linear timeline with a draggable time window. Positions are in
 * [0, 1] scale space, so a window keeps its visual width as it moves and
 * naturally covers more years in antiquity than in modern times.
 */
export class Timeline {
  private a: number;
  private b: number;
  private track: HTMLElement;
  private win: HTMLElement;
  private rangeEl: HTMLElement;
  private bordersEl: HTMLElement;
  private statusEl: HTMLElement;
  private statusText: HTMLElement;
  private glide = 0;
  private playTimer: number | undefined;
  private play = loadPlay();
  /** −3..3: which way time runs, and how fast (0: paused). */
  private speed = 0;
  private lastSpeed = 1;
  private speedBtns = new Map<number, HTMLButtonElement>();
  private marksEl: HTMLElement;
  /** A step of the file chosen on the timeline. */
  onMark: (i: number) => void = () => undefined;

  /** `onChange` gets the whole years shown and the same window to the day. */
  constructor(root: HTMLElement, initial: TimeWindow, private onChange: (w: TimeWindow, moment: TimeWindow) => void) {
    this.a = yearToPos(initial.tStart);
    this.b = yearToPos(initial.tEnd);
    root.innerHTML = `
      <div class="tl-head">
        <div class="tl-play">
          <div class="tl-transport" role="group" aria-label="Défilement du temps">${SPEEDS.map((v) =>
            `<button type="button" class="tl-speed${v === 0 ? ' pause' : ''}" data-speed="${v}" aria-label="${SPEED_TITLES[v]}" title="${SPEED_TITLES[v]}">${speedIcon(v)}</button>`,
          ).join('')}</div>
          <select class="tl-play-step" aria-label="Pas de temps" title="Avance à chaque pas">
            ${PLAY_STEPS.map((x) => `<option value="${x.id}">${x.label}</option>`).join('')}
          </select>
          <select class="tl-play-delay" aria-label="Cadence" title="Temps entre deux pas">
            ${PLAY_DELAYS.map((d) => `<option value="${d}">toutes les ${String(d).replace('.', ',')} s</option>`).join('')}
          </select>
        </div>
        <div class="tl-range"></div>
        <div class="tl-borders"></div>
        <div class="tl-status"><span class="tl-status-dot"></span><svg class="tl-hourglass" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/><path class="sand" d="M9.5 19.5h5l-2.5-2.5z" fill="currentColor" stroke="none"/></svg><span class="tl-status-text">Connexion…</span></div>
      </div>
      <div class="tl-track" role="slider" tabindex="0" aria-label="Fenêtre temporelle">
        <div class="tl-eras">${ERAS.map((e) => {
          const l = yearToPos(e.from) * 100;
          return `<div class="tl-era" style="left:${l}%;width:${yearToPos(e.to) * 100 - l}%">${e.label}</div>`;
        }).join('')}</div>
        <div class="tl-ticks">${TIMELINE_TICKS.map((y) => {
          const l = yearToPos(y) * 100;
          return `<div class="tl-tick" style="left:${l}%"></div><div class="tl-tick-label" style="left:${l}%">${tickLabel(y)}</div>`;
        }).join('')}</div>
        <div class="tl-window"><div class="tl-handle start"></div><div class="tl-handle end"></div></div>
        <div class="tl-marks" aria-label="Les étapes de votre file"></div>
      </div>`;
    this.track = root.querySelector('.tl-track')!;
    this.win = root.querySelector('.tl-window')!;
    this.marksEl = root.querySelector('.tl-marks')!;
    this.marksEl.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('.tl-mark');
      if (b) this.onMark(Number(b.dataset.i));
    });
    this.rangeEl = root.querySelector('.tl-range')!;
    this.bordersEl = root.querySelector('.tl-borders')!;
    this.statusEl = root.querySelector('.tl-status')!;
    this.statusText = root.querySelector('.tl-status-text')!;
    this.bindPlay(root);
    this.bind();
    this.render();
    requestAnimationFrame(() => this.layoutTicks());
    window.addEventListener('resize', () => this.layoutTicks());
  }

  /** Hide tick labels that would overlap their left neighbor. */
  private layoutTicks(): void {
    let lastRight = -Infinity;
    for (const el of this.track.querySelectorAll<HTMLElement>('.tl-tick-label')) {
      el.style.visibility = '';
      const r = el.getBoundingClientRect();
      if (r.left < lastRight + 6) el.style.visibility = 'hidden';
      else lastRight = r.right;
    }
  }

  /** Years shown, whole (for points and borders): a window under a year gives its year. */
  get window(): TimeWindow {
    const m = this.moment;
    if (m.tEnd - m.tStart < 1) {
      const y = Math.floor((m.tStart + m.tEnd) / 2) || 1;
      return { tStart: y, tEnd: y };
    }
    return { tStart: posToYear(this.a), tEnd: posToYear(this.b) };
  }

  /** The window in decimal years, to the day (people and armies move with it). */
  get moment(): TimeWindow {
    return { tStart: posToDecimalYear(this.a), tEnd: posToDecimalYear(this.b) };
  }

  /** Takes decimal years too (a saved window of a few days). */
  setWindow(w: TimeWindow): void {
    this.a = yearToPos(w.tStart);
    this.b = yearToPos(w.tEnd);
    this.commit();
  }

  /** Glides the window, keeping its visual width, until it is centered on `year`. */
  glideTo(year: number, ms = 1800): void {
    const w = this.b - this.a;
    const target = Math.max(0, Math.min(1 - w, yearToPos(year) - w / 2));
    const from = this.a;
    const start = performance.now();
    const token = ++this.glide;
    const step = () => {
      if (token !== this.glide) return; // superseded, or the user grabbed the window
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; // ease-in-out
      this.a = from + (target - from) * e;
      this.b = this.a + w;
      this.commit();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  get playing(): boolean {
    return this.speed !== 0;
  }

  /** Years the window moves per step: the chosen value, or the era's unit (1 year today, 100 in antiquity). */
  private stepYears(): number {
    const fixed = PLAY_STEPS.find((x) => x.id === this.play.step)?.years ?? 0;
    if (fixed > 0) return fixed;
    // A window of days or months goes forward by its own length.
    const m = this.moment;
    if (m.tEnd - m.tStart < 1) return m.tEnd - m.tStart;
    const { tStart, tEnd } = this.window;
    return Math.max(1, Math.round(bucketStep(Math.round((tStart + tEnd) / 2)) / 2));
  }

  /** The window becomes one step wide, around its middle: it shows what each step brings. */
  private fitToStep(): void {
    const years = PLAY_STEPS.find((x) => x.id === this.play.step)?.years ?? 0;
    if (!years) return;
    const { tStart, tEnd } = this.moment;
    const c = (tStart + tEnd) / 2;
    // Under a year, the window starts at midnight of the day in the middle: one whole day, week or month.
    const from = years < 1 ? Math.floor(c) + Math.floor((c - Math.floor(c)) * 365 + 1e-6) / 365 : c - years / 2;
    const a = yearToPos(from);
    const b = yearToPos(from + years);
    if (Math.abs(b - a - (this.b - this.a)) < 1e-9) return;
    this.glide++;
    this.setRange(a, b);
  }

  /** Play (the last speed chosen) or pause. */
  setPlaying(on: boolean): void {
    this.setSpeed(on ? this.lastSpeed : 0);
  }

  /**
   * Runs time at a speed: forward or back, each notch 3 times faster; under
   * a step every 150 ms, steps get longer instead.
   */
  setSpeed(v: number): void {
    v = Math.max(-3, Math.min(3, Math.round(v)));
    const was = this.speed;
    clearInterval(this.playTimer);
    this.playTimer = undefined;
    this.speed = v;
    if (v !== 0) {
      this.lastSpeed = v;
      if (was === 0) this.fitToStep();
      const every = (this.play.delay * 1000) / SPEED_RATE[Math.abs(v)]!;
      const interval = Math.max(MIN_INTERVAL_MS, every);
      const mul = interval / every;
      const dir = Math.sign(v);
      this.advance(dir * mul, interval);
      this.playTimer = window.setInterval(() => this.advance(dir * mul, interval), interval);
    }
    for (const [s, b] of this.speedBtns) b.setAttribute('aria-pressed', String(s === v));
  }

  /** One play step (`k` steps, negative going back), with a short glide. */
  private advance(k: number, interval: number): void {
    const { tStart, tEnd } = this.moment;
    const step = this.stepYears() * k;
    if ((k > 0 && tEnd >= MAX_YEAR) || (k < 0 && tStart <= MIN_YEAR)) {
      this.setSpeed(0);
      return;
    }
    const d = k > 0 ? Math.min(step, MAX_YEAR - tEnd) : Math.max(step, MIN_YEAR - tStart);
    const fromA = this.a;
    const fromB = this.b;
    const toA = yearToPos(tStart + d);
    const toB = yearToPos(tEnd + d);
    const start = performance.now();
    const token = ++this.glide;
    const ms = Math.min(600, interval * 0.4);
    const tick = () => {
      if (token !== this.glide) return;
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = 1 - (1 - t) ** 3;
      this.a = fromA + (toA - fromA) * e;
      this.b = fromB + (toB - fromB) * e;
      this.commit();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private bindPlay(root: HTMLElement): void {
    const stepSel = root.querySelector<HTMLSelectElement>('.tl-play-step')!;
    const delaySel = root.querySelector<HTMLSelectElement>('.tl-play-delay')!;
    stepSel.value = String(this.play.step);
    delaySel.value = String(this.play.delay);
    const persist = () => {
      const stepChanged = this.play.step !== stepSel.value;
      this.play = { step: stepSel.value, delay: Number(delaySel.value) };
      try {
        localStorage.setItem(PLAY_KEY, JSON.stringify(this.play));
      } catch {
        /* not remembered */
      }
      if (stepChanged) this.fitToStep();
      if (this.playing) this.setSpeed(this.speed); // new cadence right away
    };
    stepSel.addEventListener('change', persist);
    delaySel.addEventListener('change', persist);
    root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      const v = Number(b.dataset.speed);
      this.speedBtns.set(v, b);
      b.addEventListener('click', () => this.setSpeed(v));
    });
    // Space: play / pause; ← back, faster at each press; → forward, likewise; ↓ pause.
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') {
        if (t.tagName === 'BUTTON') return;
        this.setPlaying(!this.playing);
      } else if (t === this.track) return; // the window has its own arrows
      else if (e.key === 'ArrowRight') this.setSpeed(this.speed > 0 ? this.speed + 1 : 1);
      else if (e.key === 'ArrowLeft') this.setSpeed(this.speed < 0 ? this.speed - 1 : -1);
      else if (e.key === 'ArrowDown') this.setSpeed(0);
      else return;
      e.preventDefault();
    });
    this.setSpeed(0);
  }

  /** The scenario's file on the timeline: a mark per step, the one now larger (none: nothing in the file). */
  setMarks(marks: TimeMark[]): void {
    // The one now drawn last, above the others.
    const sorted = [...marks].sort((a, b) => Number(a.state === 'now') - Number(b.state === 'now'));
    this.marksEl.innerHTML = sorted.map((m) => {
      const label = m.title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      return `<button type="button" class="tl-mark ${m.state}${m.crochet ? ' cr' : ''}" style="left:${(yearToPos(m.year) * 100).toFixed(3)}%" data-i="${m.i}" title="${label}" aria-label="Étape ${label}"><span></span></button>`;
    }).join('');
  }

  setBordersNote(text: string): void {
    this.bordersEl.textContent = text;
  }

  /**
   * Search activity, kept discreet: nothing when idle, a pulsing dot while
   * points are fetched, an hourglass while the AI searches the web.
   */
  setStatus(state: 'idle' | 'busy' | 'ai' | 'offline', text: string, title = text): void {
    this.statusEl.className = `tl-status ${state}`;
    this.statusText.textContent = text;
    this.statusEl.title = title;
  }

  private render(): void {
    this.win.style.left = `${this.a * 100}%`;
    this.win.style.width = `${(this.b - this.a) * 100}%`;
    // A window of a few days is thinner than its drawn minimum: keep it centered on its date,
    // without handles (grabbing it moves it finely).
    const px = (this.b - this.a) * this.track.clientWidth;
    this.win.style.marginLeft = px < THIN_PX ? `${-(THIN_PX - px) / 2}px` : '';
    this.win.classList.toggle('thin', px < FINE_PX);
    const m = this.moment;
    const days = Math.round((m.tEnd - m.tStart) * 365);
    let text: string;
    let label: string;
    if (days <= 1) {
      text = label = formatDay(m.tStart);
    } else if (m.tEnd - m.tStart < 2) {
      // The last day shown is the one before the end.
      const last = formatDay(m.tEnd - DAY);
      text = `${formatDay(m.tStart)}<em>→</em>${last}`;
      label = `du ${formatDay(m.tStart)} au ${last}`;
    } else {
      const { tStart, tEnd } = this.window;
      text = `${formatYear(tStart)}<em>→</em>${formatYear(tEnd)}`;
      label = `de ${formatYear(tStart)} à ${formatYear(tEnd)}`;
    }
    this.rangeEl.innerHTML = text;
    this.track.setAttribute('aria-valuetext', label);
  }

  private commit(): void {
    this.render();
    this.onChange(this.window, this.moment);
  }

  /** Narrowest window at a position: one day there. */
  private minWidth(pos: number): number {
    return widthAt(posToDecimalYear(pos), MIN_YEARS);
  }

  private setRange(a: number, b: number): void {
    const w = Math.min(MAX_WIDTH, Math.max(this.minWidth((a + b) / 2), b - a));
    a = Math.max(0, Math.min(1 - w, a));
    this.a = a;
    this.b = a + w;
    this.commit();
  }

  private posFromEvent(e: PointerEvent | WheelEvent): number {
    const r = this.track.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  }

  private bind(): void {
    type Mode = 'move' | 'start' | 'end' | 'fine';
    let drag: { mode: Mode; origin: number; x: number; a: number; b: number; t0: number; years: number } | null = null;

    this.track.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tl-mark')) return; // a step of the file: clicked, not dragged
      const p = this.posFromEvent(e);
      const thin = this.win.classList.contains('thin');
      let mode: Mode = 'move';
      if (target.classList.contains('start') && !thin) mode = 'start';
      else if (target.classList.contains('end') && !thin) mode = 'end';
      else if (!this.win.contains(target)) {
        // Click on the track: center the window there, then keep dragging it.
        const w = this.b - this.a;
        this.setRange(p - w / 2, p + w / 2);
      } else if (thin) mode = 'fine';
      this.glide++; // the user takes over
      this.setSpeed(0);
      const m = this.moment;
      drag = { mode, origin: p, x: e.clientX, a: this.a, b: this.b, t0: m.tStart, years: m.tEnd - m.tStart };
      this.track.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.track.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = this.posFromEvent(e) - drag.origin;
      if (drag.mode === 'fine') {
        // A few days wide: the window moves by days, then faster as the pointer goes further.
        let t = drag.t0 + fineShift(e.clientX - drag.x, drag.years);
        if (drag.years < 1) t = Math.round(t * 365) / 365; // from midnight to midnight
        t = Math.max(MIN_YEAR, Math.min(MAX_YEAR - drag.years, t));
        this.a = yearToPos(t);
        this.b = yearToPos(t + drag.years);
        this.commit();
      } else if (drag.mode === 'move') this.setRange(drag.a + d, drag.b + d);
      else if (drag.mode === 'start') {
        const a = Math.max(0, Math.min(drag.b - this.minWidth(drag.b), drag.a + d));
        this.a = Math.max(a, drag.b - MAX_WIDTH);
        this.b = drag.b;
        this.commit();
      } else {
        const b = Math.min(1, Math.max(drag.a + this.minWidth(drag.a), drag.b + d));
        this.a = drag.a;
        this.b = Math.min(b, drag.a + MAX_WIDTH);
        this.commit();
      }
    });

    const end = () => { drag = null; };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);

    // Wheel: widen / narrow the window around its center.
    this.track.addEventListener('wheel', (e) => {
      e.preventDefault();
      const c = (this.a + this.b) / 2;
      const w = (this.b - this.a) * (e.deltaY > 0 ? 1.15 : 1 / 1.15);
      this.setRange(c - w / 2, c + w / 2);
    }, { passive: false });

    this.track.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const m = this.moment;
      const years = m.tEnd - m.tStart;
      if (years < 1) {
        // Under a year: a whole window at a time (a day, a week), ten with Shift.
        const t = Math.round((m.tStart + dir * years * (e.shiftKey ? 10 : 1)) * 365) / 365;
        this.setWindow({ tStart: t, tEnd: t + years });
        return;
      }
      const w = this.b - this.a;
      const step = (e.shiftKey ? w : w / 4) * dir;
      this.setRange(this.a + step, this.b + step);
    });
  }
}
