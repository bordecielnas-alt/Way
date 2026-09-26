import { EventEmitter } from 'node:events';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Config } from './config.ts';
import { jobKeys, runSearchJob, type SearchJob } from './pipeline.ts';
import type { Store } from './store/types.ts';

const QUEUE_NAME = 'search';
const DONE_CHANNEL = 'way:keys-done';

/** Job transport between the API (producer) and the search pipeline (consumer). */
export interface JobBus {
  enqueue(jobs: SearchJob[]): Promise<void>;
  onKeysDone(cb: (keys: string[]) => void): void;
  stats(): Promise<{ waiting: number; active: number }>;
  close(): Promise<void>;
}

async function runAndRecord(job: SearchJob, store: Store, cfg: Config): Promise<string[]> {
  const started = Date.now();
  try {
    const r = await runSearchJob(job, store, cfg);
    console.log(`[search] ${describe(job)} -> ${r.found} new POIs in ${Date.now() - started} ms`);
    return r.keys;
  } catch (e) {
    console.warn(`[search] ${describe(job)} failed after ${Date.now() - started} ms:`, (e as Error).message);
    const keys = jobKeys(job);
    await store.setKeys(keys, 'failed');
    return keys;
  }
}

function describe(job: SearchJob): string {
  const range = `${job.buckets[0]}..${job.buckets[job.buckets.length - 1]}`;
  return job.kind === 'global' ? `global ${range}` : `area ${job.area} (${job.cells.length} cells) ${range}`;
}

/** Local dev: runs jobs in-process, newest first (the current view wins). */
export class InlineBus implements JobBus {
  private queue: SearchJob[] = [];
  private active = 0;
  private events = new EventEmitter();

  constructor(private store: Store, private cfg: Config) {}

  async enqueue(jobs: SearchJob[]): Promise<void> {
    this.queue.push(...[...jobs].reverse());
    this.pump();
  }

  private pump(): void {
    while (this.active < this.cfg.workerConcurrency && this.queue.length > 0) {
      const job = this.queue.pop()!;
      this.active++;
      runAndRecord(job, this.store, this.cfg)
        .then((keys) => this.events.emit('done', keys))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  onKeysDone(cb: (keys: string[]) => void): void {
    this.events.on('done', cb);
  }

  async stats() {
    return { waiting: this.queue.length, active: this.active };
  }

  async close(): Promise<void> {
    this.queue = [];
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
export function startRedisWorker(url: string, store: Store, cfg: Config): { close(): Promise<void> } {
  const pub = redis(url);
  const worker = new Worker<SearchJob>(
    QUEUE_NAME,
    async (job) => {
      const keys = await runAndRecord(job.data, store, cfg);
      await pub.publish(DONE_CHANNEL, JSON.stringify(keys));
    },
    { connection: redis(url), concurrency: cfg.workerConcurrency },
  );
  worker.on('error', (e) => console.error('[worker] error', e.message));
  return {
    async close() {
      await worker.close();
      pub.disconnect();
    },
  };
}
