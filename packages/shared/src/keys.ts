// Search keys: `${space}|${bucket}|${filter}` (brief §6.2).
// `space` is an H3 cell for fine views, or GLOBAL_SPACE for the
// global time-first search used at globe/continent zoom.

export const GLOBAL_SPACE = 'g';
export const DEFAULT_FILTER = 'all';

export function makeKey(space: string, bucket: number, filter = DEFAULT_FILTER): string {
  return `${space}|${bucket}|${filter}`;
}

export function parseKey(key: string): { space: string; bucket: number; filter: string } {
  const [space, bucket, filter] = key.split('|');
  return { space: space!, bucket: Number(bucket), filter: filter ?? DEFAULT_FILTER };
}
