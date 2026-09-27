import type { Config } from './config.ts';
import type { Store } from './store/types.ts';

/**
 * Bounded cache (brief §6.4): when the data outgrows the ceiling, evict the
 * least viewed POIs until it is back under 90% of it.
 */
export async function enforceCacheLimit(store: Store, cfg: Config, max = cfg.cache.maxBytes): Promise<{ bytes: number; removed: number }> {
  let bytes = await store.cacheBytes();
  let removed = 0;
  // A few rounds at most: each one re-measures, since rows vary in size.
  for (let round = 0; round < 5 && bytes > max; round++) {
    const count = await store.poiCount();
    if (count === 0) break;
    const avg = bytes / count;
    const n = await store.evict(Math.ceil((bytes - 0.9 * max) / avg), cfg.cache.pinImportance);
    if (n === 0) break; // everything left is pinned
    removed += n;
    bytes = await store.cacheBytes();
  }
  return { bytes, removed };
}
