// The frame around the globe: the bar of filters on top, the timeline along
// the bottom, the scenario's card on the left and the place's card on the
// right between them, each as wide as the visitor made it.

/** The panels between the bars follow their heights (`--top`, `--bottom`). */
export function watchBars(top: HTMLElement, bottom: HTMLElement): void {
  const css = document.documentElement.style;
  const set = () => {
    css.setProperty('--top', `${Math.round(top.getBoundingClientRect().bottom + 8)}px`);
    css.setProperty('--bottom', `${Math.round(window.innerHeight - bottom.getBoundingClientRect().top + 8)}px`);
  };
  const watch = new ResizeObserver(set);
  watch.observe(top);
  watch.observe(bottom);
  window.addEventListener('resize', set);
  set();
}

/** The globe keeps at least this much between the two cards. */
const GLOBE_MIN = 320;
/** The margins around and between the panels. */
const EDGES = 48;
const KEY_STEP = 24;

export interface Panel {
  /** The handle on the card's inner edge. */
  grip: HTMLElement;
  /** Which edge of the screen the card is on: its handle is on the other side. */
  side: 'left' | 'right';
  /** The CSS variable holding its width. */
  cssVar: string;
  /** Where the width chosen is kept. */
  key: string;
  def: number;
  min: number;
  max: number;
  /** The other card's width, while it shows (0 otherwise). */
  other: () => number;
}

export interface Resizable {
  readonly width: number;
  /** Narrowed if the window or the other card leaves the globe too little. */
  fit(): void;
}

/**
 * A card made wider or narrower by its handle: dragged, with the arrows
 * (24 px a press), back to its width by default on a double click. The width
 * is kept in this browser.
 */
export function resizable(p: Panel): Resizable {
  /** The width chosen; the one shown is narrower while the window leaves the globe too little. */
  let wanted = p.def;
  try {
    const saved = Number(localStorage.getItem(p.key));
    if (saved) wanted = saved;
  } catch {
    /* storage unavailable: the width by default */
  }
  let width = wanted;
  const cap = () => Math.max(p.min, Math.min(p.max, window.innerWidth - EDGES - p.other() - GLOBE_MIN));
  const show = () => {
    width = Math.round(Math.max(p.min, Math.min(cap(), wanted)));
    document.documentElement.style.setProperty(p.cssVar, `${width}px`);
    p.grip.setAttribute('aria-valuenow', String(width));
  };
  /** A width chosen by the visitor (kept once let go). */
  const set = (w: number, keep: boolean) => {
    wanted = Math.round(Math.max(p.min, Math.min(cap(), w)));
    show();
    if (!keep) return;
    try {
      localStorage.setItem(p.key, String(wanted));
    } catch {
      /* not remembered */
    }
  };
  document.documentElement.style.setProperty(p.cssVar, `${width}px`);
  p.grip.setAttribute('role', 'separator');
  p.grip.setAttribute('aria-orientation', 'vertical');
  p.grip.setAttribute('aria-valuemin', String(p.min));
  p.grip.setAttribute('aria-valuemax', String(p.max));
  p.grip.setAttribute('aria-valuenow', String(width));

  const sign = p.side === 'left' ? 1 : -1;
  let drag: { x: number; w: number } | null = null;
  p.grip.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, w: width };
    p.grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  p.grip.addEventListener('pointermove', (e) => {
    if (drag) set(drag.w + sign * (e.clientX - drag.x), false);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('resizing');
    set(width, true);
  };
  p.grip.addEventListener('pointerup', end);
  p.grip.addEventListener('pointercancel', end);
  p.grip.addEventListener('dblclick', () => set(p.def, true));
  p.grip.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    set(width + sign * d * KEY_STEP, true);
  });
  window.addEventListener('resize', show);
  return {
    get width() {
      return width;
    },
    fit: show,
  };
}
