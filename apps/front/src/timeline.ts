import { formatYear, posToYear, TIMELINE_TICKS, yearToPos, MAX_YEAR, MIN_YEAR } from '@way/shared';

export interface TimeWindow { tStart: number; tEnd: number }

const ERAS: { label: string; from: number; to: number }[] = [
  { label: 'Préhistoire', from: MIN_YEAR, to: -3300 },
  { label: 'Antiquité', from: -3300, to: 476 },
  { label: 'Moyen Âge', from: 476, to: 1492 },
  { label: 'Temps modernes', from: 1492, to: 1789 },
  { label: 'Époque contemporaine', from: 1789, to: MAX_YEAR },
];

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

  constructor(root: HTMLElement, initial: TimeWindow, private onChange: (w: TimeWindow) => void) {
    this.a = yearToPos(initial.tStart);
    this.b = yearToPos(initial.tEnd);
    root.innerHTML = `
      <div class="tl-head">
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
