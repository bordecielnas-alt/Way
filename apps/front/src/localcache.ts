// Small per-browser cache for territory cards and region lists: shown at
// once on the next visit, then checked against the server in the background.
// Best effort: private windows or full storage just mean no cache.

const PREFIX = 'way:c:';
const INDEX = 'way:c-index';
const MAX_ENTRIES = 250;

function index(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Stores a value; returns true when it differs from what was cached. */
export function cachePut(key: string, value: unknown): boolean {
  try {
    const raw = JSON.stringify(value);
    if (localStorage.getItem(PREFIX + key) === raw) return false;
    // Least recently written entries go first when the cache is full.
    const keys = index().filter((k) => k !== key);
    keys.push(key);
    while (keys.length > MAX_ENTRIES) localStorage.removeItem(PREFIX + keys.shift()!);
    localStorage.setItem(PREFIX + key, raw);
    localStorage.setItem(INDEX, JSON.stringify(keys));
    return true;
  } catch {
    return true; // storage full or blocked: the fresh value is still used
  }
}

/**
 * Stale-while-revalidate fetch: `onValue` gets the cached value at once (if
 * any), then the server's value if it differs. Resolves with the latest value.
 */
export async function fetchCached<T>(url: string, onValue: (v: T, fresh: boolean) => void): Promise<T | null> {
  const cached = cacheGet<T>(url);
  if (cached) onValue(cached, false);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const v = (await r.json()) as T;
    if (cachePut(url, v) || !cached) onValue(v, true);
    return v;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
