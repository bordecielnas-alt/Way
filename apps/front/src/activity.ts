// Work going on in the background (an AI reading, names being looked up),
// gathered for the discreet status at the end of the timeline.

export interface Activity {
  /** Short label shown next to the icon. */
  label: string;
  /** Longer text for the tooltip. */
  title: string;
  /** An AI is at work (hourglass), else a plain lookup (dot). */
  ai: boolean;
}

const running = new Map<string, Activity>();
const listeners = new Set<() => void>();

/** Turns one kind of work on (or updates it) or off; `key` names it. */
export function setActivity(key: string, activity: Activity | null): void {
  const before = running.get(key);
  if (activity) running.set(key, activity);
  else running.delete(key);
  if (JSON.stringify(before) !== JSON.stringify(activity ?? undefined)) for (const f of listeners) f();
}

/** What to show: AI work first, then the most recent lookup. */
export function currentActivity(): (Activity & { more: number }) | null {
  const all = [...running.values()];
  if (!all.length) return null;
  const first = all.find((a) => a.ai) ?? all[all.length - 1]!;
  return { ...first, more: all.length - 1 };
}

export function onActivity(f: () => void): void {
  listeners.add(f);
}
