import { bucketStep, formatYear, posToYear, TIMELINE_TICKS, yearToPos, MAX_YEAR, MIN_YEAR } from '@way/shared';

export interface TimeWindow { tStart: number; tEnd: number }

const ERAS: { label: string; from: number; to: number }[] = [
  { label: 'Préhistoire', from: MIN_YEAR, to: -3300 },
  { label: 'Antiquité', from: -3300, to: 476 },
  { label: 'Moyen Âge', from: 476, to: 1492 },
  { label: 'Temps modernes', from: 1492, to: 1789 },
  { label: 'Époque contemporaine', from: 1789, to: MAX_YEAR },
];

/** Play mode: years per step (0 = the timeline's own unit at that era) and seconds between steps. */
const PLAY_STEPS = [0, 1, 5, 10, 25, 50, 100];
const PLAY_DELAYS = [1, 2, 3, 5, 10];
const PLAY_KEY = 'way:play';
interface PlayPrefs { step: number; delay: number }

function loadPlay(): PlayPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PLAY_KEY) ?? '{}') as Partial<PlayPrefs>;
    return {
      step: PLAY_STEPS.includes(p.step ?? -1) ? p.step! : 0,
      delay: PLAY_DELAYS.includes(p.delay ?? -1) ? p.delay! : 2,
    };
  } catch {
    return { step: 0, delay: 2 };
  }
}

const MIN_WIDTH = 0.004;
const MAX_WIDTH = 0.45;

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
  private playBtn: HTMLButtonElement;

  constructor(root: HTMLElement, initial: TimeWindow, private onChange: (w: TimeWindow) => void) {
    this.a = yearToPos(initial.tStart);
    this.b = yearToPos(initial.tEnd);
    root.innerHTML = `
      <div class="tl-head">
        <div class="tl-play">
          <button type="button" class="tl-play-btn" aria-label="Lecture" title="Faire défiler le temps (Espace)"></button>
          <select class="tl-play-step" aria-label="Pas de temps" title="Avance à chaque pas">
            ${PLAY_STEPS.map((y) => `<option value="${y}">${y === 0 ? 'Pas auto' : `+${y} an${y > 1 ? 's' : ''}`}</option>`).join('')}
          </select>
          <select class="tl-play-delay" aria-label="Cadence" title="Temps entre deux pas">
            ${PLAY_DELAYS.map((d) => `<option value="${d}">toutes les ${d} s</option>`).join('')}
          </select>
        </div>
        <div class="tl-range"></div>
        <div class="tl-borders"></div>
        <div class="tl-status"><span class="tl-status-dot"></span><span class="tl-status-text">Connexion…</span></div>
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
      </div>`;
    this.track = root.querySelector('.tl-track')!;
    this.win = root.querySelector('.tl-window')!;
    this.rangeEl = root.querySelector('.tl-range')!;
    this.bordersEl = root.querySelector('.tl-borders')!;
    this.statusEl = root.querySelector('.tl-status')!;
    this.statusText = root.querySelector('.tl-status-text')!;
    this.playBtn = root.querySelector('.tl-play-btn')!;
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

  get window(): TimeWindow {
    return { tStart: posToYear(this.a), tEnd: posToYear(this.b) };
  }

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
    return this.playTimer !== undefined;
  }

  /** Years the window moves per step: the chosen value, or the era's unit (1 year today, 100 in antiquity). */
  private stepYears(): number {
    if (this.play.step > 0) return this.play.step;
    const { tStart, tEnd } = this.window;
    return Math.max(1, Math.round(bucketStep(Math.round((tStart + tEnd) / 2)) / 2));
  }

  setPlaying(on: boolean): void {
    clearInterval(this.playTimer);
    this.playTimer = undefined;
    if (on) {
      this.advance();
      this.playTimer = window.setInterval(() => this.advance(), this.play.delay * 1000);
    }
    this.playBtn.classList.toggle('on', on);
    this.playBtn.setAttribute('aria-label', on ? 'Pause' : 'Lecture');
    this.playBtn.innerHTML = on
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z"/></svg>';
  }

  /** One play step: the window slides forward by the same number of years, with a short glide. */
  private advance(): void {
    const { tStart, tEnd } = this.window;
    const step = this.stepYears();
    if (tEnd >= MAX_YEAR) {
      this.setPlaying(false);
      return;
    }
    const d = Math.min(step, MAX_YEAR - tEnd);
    const fromA = this.a;
    const fromB = this.b;
    const toA = yearToPos(tStart + d);
    const toB = yearToPos(tEnd + d);
    const start = performance.now();
    const token = ++this.glide;
    const ms = Math.min(600, this.play.delay * 400);
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
      this.play = { step: Number(stepSel.value), delay: Number(delaySel.value) };
      try {
        localStorage.setItem(PLAY_KEY, JSON.stringify(this.play));
      } catch {
        /* not remembered */
      }
      if (this.playing) this.setPlaying(true); // new cadence right away
    };
    stepSel.addEventListener('change', persist);
    delaySel.addEventListener('change', persist);
    this.playBtn.addEventListener('click', () => this.setPlaying(!this.playing));
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName) || t.isContentEditable) return;
      e.preventDefault();
      this.setPlaying(!this.playing);
    });
    this.setPlaying(false);
  }

  setBordersNote(text: string): void {
    this.bordersEl.textContent = text;
  }

  setStatus(state: 'idle' | 'busy' | 'offline', text: string): void {
    this.statusEl.className = `tl-status ${state}`;
    this.statusText.textContent = text;
  }

  private render(): void {
    this.win.style.left = `${this.a * 100}%`;
    this.win.style.width = `${(this.b - this.a) * 100}%`;
    const { tStart, tEnd } = this.window;
    this.rangeEl.innerHTML = `${formatYear(tStart)}<em>→</em>${formatYear(tEnd)}`;
    this.track.setAttribute('aria-valuetext', `de ${formatYear(tStart)} à ${formatYear(tEnd)}`);
  }

  private commit(): void {
    this.render();
    this.onChange(this.window);
  }

  private setRange(a: number, b: number): void {
    const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, b - a));
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
    type Mode = 'move' | 'start' | 'end';
    let drag: { mode: Mode; origin: number; a: number; b: number } | null = null;

    this.track.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      const p = this.posFromEvent(e);
      let mode: Mode = 'move';
      if (target.classList.contains('start')) mode = 'start';
      else if (target.classList.contains('end')) mode = 'end';
      else if (!this.win.contains(target)) {
        // Click on the track: center the window there, then keep dragging it.
        const w = this.b - this.a;
        this.setRange(p - w / 2, p + w / 2);
      }
      this.glide++; // the user takes over
      this.setPlaying(false);
      drag = { mode, origin: p, a: this.a, b: this.b };
      this.track.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.track.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = this.posFromEvent(e) - drag.origin;
      if (drag.mode === 'move') this.setRange(drag.a + d, drag.b + d);
      else if (drag.mode === 'start') {
        const a = Math.max(0, Math.min(drag.b - MIN_WIDTH, drag.a + d));
        this.a = Math.max(a, drag.b - MAX_WIDTH);
        this.b = drag.b;
        this.commit();
      } else {
        const b = Math.min(1, Math.max(drag.a + MIN_WIDTH, drag.b + d));
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
      const w = this.b - this.a;
      const step = e.shiftKey ? w : w / 4;
      if (e.key === 'ArrowLeft') this.setRange(this.a - step, this.b - step);
      else if (e.key === 'ArrowRight') this.setRange(this.a + step, this.b + step);
      else return;
      e.preventDefault();
    });
  }
}
