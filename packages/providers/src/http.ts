// Polite HTTP client for open APIs: identifiable User-Agent, per-host
// concurrency and spacing limits, retry on 429/5xx honoring Retry-After.

export interface HostPolicy {
  concurrency: number;
  minIntervalMs: number;
}

const DEFAULT_POLICY: HostPolicy = { concurrency: 2, minIntervalMs: 100 };

const POLICIES: Record<string, HostPolicy> = {
  // WDQS allows 5 parallel queries per IP; stay well below.
  'query.wikidata.org': { concurrency: 2, minIntervalMs: 250 },
  // The search API answers bursts with a 40 s Retry-After: one request at a time.
  'www.wikidata.org': { concurrency: 1, minIntervalMs: 150 },
  'nominatim.openstreetmap.org': { concurrency: 1, minIntervalMs: 1100 },
};

let userAgent = 'Way/0.1 (personal history globe; self-hosted)';

export function setUserAgent(ua: string): void {
  userAgent = ua;
}

class HostLimiter {
  private active = 0;
  private last = 0;
  private queue: (() => void)[] = [];
  constructor(private policy: HostPolicy) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private pump(): void {
    if (this.active >= this.policy.concurrency || this.queue.length === 0) return;
    const wait = this.last + this.policy.minIntervalMs - Date.now();
    if (wait > 0) {
      setTimeout(() => this.pump(), wait);
      return;
    }
    this.active++;
    this.last = Date.now();
    this.queue.shift()!();
    this.pump();
  }
}

const limiters = new Map<string, HostLimiter>();

function limiterFor(host: string): HostLimiter {
  let l = limiters.get(host);
  if (!l) {
    l = new HostLimiter(POLICIES[host] ?? DEFAULT_POLICY);
    limiters.set(host, l);
  }
  return l;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hosts that answered 429: background work waits until this time. */
const cooling = new Map<string, number>();

/** When a host that asked us to slow down accepts requests again (0 if it did not). */
export function coolingUntil(host: string): number {
  return cooling.get(host) ?? 0;
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 20_000, retries = 2 } = opts;
  const host = new URL(url).host;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) console.warn(`[http] ${host}: retry ${attempt} after ${Date.now() - started} ms`);
    const res = await limiterFor(host).run(() =>
      fetch(url, {
        method: opts.method ?? 'GET',
        body: opts.body,
        headers: { 'User-Agent': userAgent, Accept: 'application/json', ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (res.ok) return (await res.json()) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `${res.status} ${host}: ${text.slice(0, 200)}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
    if (res.status === 429) cooling.set(host, Math.max(coolingUntil(host), Date.now() + wait));
    await sleep(wait);
  }
}
