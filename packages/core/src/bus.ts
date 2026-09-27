import { EventEmitter } from 'node:events';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Config } from './config.ts';
import { jobKeys, runSearchJob, type SearchJob } from './pipeline.ts';
import type { ProviderRouter } from './router.ts';
import type { Store } from './store/types.ts';

const QUEUE_NAME = 'search';
const DONE_CHANNEL = 'way:keys-done';

/** Job transport between the API (producer) and the search pipeline (consumer). */
export interface JobBus {
  enqueue(jobs: SearchJob[]): Promise<void>;
  /** Low-priority searches (the periods next to the view), run only when nothing else waits. */
  prefetch(jobs: SearchJob[]): Promise<void>;
  onKeysDone(cb: (keys: string[]) => void): void;
  stats(): Promise<{ waiting: number; active: number }>;
  close(): Promise<void>;
}

async function runAndRecord(
  job: SearchJob, store: Store, cfg: Config, router?: ProviderRouter,
): Promise<{ keys: string[]; followUp?: SearchJob }> {
  const started = Date.now();
  try {
    const r = await runSearchJob(job, store, cfg, router);
    const next = r.followUp ? ' (poor: level 2 queued)' : '';
    console.log(`[search] ${describe(job)} -> ${r.found} new POIs in ${Date.now() - started} ms${next}`);
    return { keys: r.keys, followUp: r.followUp };
  } catch (e) {
    console.warn(`[search] ${describe(job)} failed after ${Date.now() - started} ms:`, (e as Error).message);
    const keys = jobKeys(job);
    await store.setKeys(keys, 'failed');
    return { keys };
  }
}

function describe(job: SearchJob): string {
  const range = `${job.buckets[0]}..${job.buckets[job.buckets.length - 1]}`;
  if (job.kind === 'global') return `global ${range}`;
  return `${job.kind === 'deep' ? 'level-2 area' : 'area'} ${job.area} (${job.cells.length} cells) ${range}`;
}

interface Lane { queue: SearchJob[]; active: number; concurrency: number }

/** Prefetch jobs kept at most; older guesses are dropped for newer ones. */
const PREFETCH_MAX = 24;

/**
 * In-process queue, newest first (the current view wins). Level-2 jobs run
 * in their own lane, one at a time, so they never delay level 1.
 */
export class InlineBus implements JobBus {
  private fast: Lane;
  private deep: Lane = { queue: [], active: 0, concurrency: 1 };
  private idle: Lane = { queue: [], active: 0, concurrency: 1 };
  private events = new EventEmitter();

  constructor(private store: Store, private cfg: Config, private router?: ProviderRouter) {
    this.fast = { queue: [], active: 0, concurrency: cfg.workerConcurrency };
  }

  async enqueue(jobs: SearchJob[]): Promise<void> {
    for (const job of [...jobs].reverse()) (job.kind === 'deep' ? this.deep : this.fast).queue.push(job);
    this.pump(this.fast);
    this.pump(this.deep);
  }

  async prefetch(jobs: SearchJob[]): Promise<void> {
    this.idle.queue.push(...[...jobs].reverse());
    if (this.idle.queue.length > PREFETCH_MAX) this.idle.queue.splice(0, this.idle.queue.length - PREFETCH_MAX);
    this.pump(this.idle);
  }

  private pump(lane: Lane): void {
    // Prefetching waits until the searches someone is looking at are done.
    if (lane === this.idle && (this.fast.queue.length > 0 || this.fast.active >= this.fast.concurrency)) return;
    while (lane.active < lane.concurrency && lane.queue.length > 0) {
      const job = lane.queue.pop()!;
      lane.active++;
      const run = lane === this.idle ? this.runPrefetch(job) : runAndRecord(job, this.store, this.cfg, this.router);
      run
        .then(({ keys, followUp }) => {
          if (followUp) void this.enqueue([followUp]);
          if (keys.length) this.events.emit('done', keys);
        })
        .finally(() => {
          lane.active--;
          this.pump(lane);
          if (lane === this.fast) this.pump(this.idle);
        });
    }
  }

  /** Skips a guess the view has caught up with (searched or being searched since). */
  private async runPrefetch(job: SearchJob): Promise<{ keys: string[]; followUp?: SearchJob }> {
    const keys = jobKeys(job);
    const known = await this.store.getKeys(keys);
    if (keys.every((k) => known.has(k))) return { keys: [] };
    await this.store.setKeys(keys.filter((k) => !known.has(k)), 'pending');
    // No level 2 for guesses: it costs quota.
    const { keys: done } = await runAndRecord(job, this.store, this.cfg);
    return { keys: done };
  }

  onKeysDone(cb: (keys: string[]) => void): void {
    this.events.on('done', cb);
  }

  async stats() {
    return {
      waiting: this.fast.queue.length + this.deep.queue.length,
      active: this.fast.active + this.deep.active,
      prefetch: { waiting: this.idle.queue.length, active: this.idle.active },
      level2: { waiting: this.deep.queue.length, active: this.deep.active },
    };
  }

  async close(): Promise<void> {
    this.fast.queue = [];
    this.deep.queue = [];
    this.idle.queue = [];
  }
}

function redis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** Docker: BullMQ queue on Redis; completion notices via pub/sub. */
export class RedisBus implements JobBus {
  private queue: Queue;
  private sub: Redis;
  private listeners: ((keys: string[]) => void)[] = [];

  constructor(url: string) {
    this.queue = new Queue(QUEUE_NAME, { connection: redis(url) });
    this.sub = redis(url);
    this.sub.subscribe(DONE_CHANNEL).catch((e) => console.error('[bus] subscribe failed', e));
    this.sub.on('message', (_ch, msg) => {
      const keys = JSON.parse(msg) as string[];
      for (const l of this.listeners) l(keys);
    });
  }

  async enqueue(jobs: SearchJob[]): Promise<void> {
    await this.queue.addBulk(
      // LIFO: add the most urgent job (first in list) last.
      [...jobs].reverse().map((data) => ({
        name: data.kind,
        data,
        opts: { lifo: true, removeOnComplete: 500, removeOnFail: 500 },
      })),
    );
  }

  async prefetch(jobs: SearchJob[]): Promise<void> {
    // BullMQ serves lower priority numbers first; plain jobs have none, so they come before these.
    await this.queue.addBulk(
      jobs.map((data) => ({ name: data.kind, data, opts: { priority: 100, removeOnComplete: 500, removeOnFail: 500 } })),
    );
  }

  onKeysDone(cb: (keys: string[]) => void): void {
    this.listeners.push(cb);
  }

  async stats() {
    const c = await this.queue.getJobCounts('waiting', 'active', 'prioritized');
    return { waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0 };
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.sub.disconnect();
  }
}

/** Worker process side of RedisBus. */
export function startRedisWorker(url: string, store: Store, cfg: Config, router?: ProviderRouter): { close(): Promise<void> } {
  const pub = redis(url);
  const followUps = new Queue(QUEUE_NAME, { connection: redis(url) });
  const worker = new Worker<SearchJob>(
    QUEUE_NAME,
    async (job) => {
      const { keys, followUp } = await runAndRecord(job.data, store, cfg, router);
      if (followUp) await followUps.add(followUp.kind, followUp, { removeOnComplete: 500, removeOnFail: 500 });
      await pub.publish(DONE_CHANNEL, JSON.stringify(keys));
    },
    { connection: redis(url), concurrency: cfg.workerConcurrency },
  );
  worker.on('error', (e) => console.error('[worker] error', e.message));
  return {
    async close() {
      await worker.close();
      await followUps.close();
      pub.disconnect();
    },
  };
}
