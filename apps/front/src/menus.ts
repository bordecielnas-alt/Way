// The menus of the bar on top (filters, people): one open at a time, closed
// by a click elsewhere or Escape.

let current: { box: HTMLElement; close: () => void } | null = null;

document.addEventListener('pointerdown', (e) => {
  if (current && !current.box.contains(e.target as Node)) current.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current) {
    current.close();
    e.stopPropagation();
  }
}, true);

/** `button` opens and closes `pop`, inside `box`; `onToggle` hears it. */
export function bindMenu(box: HTMLElement, button: HTMLButtonElement, pop: HTMLElement, onToggle?: (open: boolean) => void): void {
  const set = (open: boolean) => {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    box.classList.toggle('open', open);
    onToggle?.(open);
  };
  const close = () => {
    set(false);
    if (current?.box === box) current = null;
  };
  button.setAttribute('aria-haspopup', 'true');
  set(false);
  button.addEventListener('click', () => {
    const open = pop.hidden;
    current?.close();
    if (!open) return;
    set(true);
    current = { box, close };
  });
}
