// Discrete-event engine behind the queue-capacity model (capacity-model.ts). Virtual time only: no
// timers, no Redis. The engine is deliberately stateful (a heap, counters, per-lane queues): a
// month of 100 organisations is ~10^5 events, and copying state per event would make the model too
// slow to run inside the unit-test suite.

/** Binary min-heap; `less` decides the order. */
export class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = items[parent] as T;
      if (!this.less(item, p)) break;
      items[i] = p;
      i = parent;
    }
    items[i] = item;
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    let i = 0;
    const n = items.length;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      const child = right < n && this.less(items[right] as T, items[left] as T) ? right : left;
      if (!this.less(items[child] as T, last)) break;
      items[i] = items[child] as T;
      i = child;
    }
    items[i] = last;
    return top;
  }
}

interface SimEvent {
  time: number;
  seq: number;
  fn: () => void;
}

/**
 * Event loop over virtual seconds. Events at the same instant run in the order they were
 * scheduled (the sequence number), which is what makes every run reproducible.
 */
export class EventLoop {
  private current = 0;
  private seq = 0;
  private readonly heap = new MinHeap<SimEvent>((a, b) =>
    a.time === b.time ? a.seq < b.seq : a.time < b.time,
  );

  get now(): number {
    return this.current;
  }

  at(time: number, fn: () => void): void {
    this.heap.push({ time: Math.max(time, this.current), seq: this.seq++, fn });
  }

  after(delaySec: number, fn: () => void): void {
    this.at(this.current + delaySec, fn);
  }

  run(): void {
    for (let ev = this.heap.pop(); ev; ev = this.heap.pop()) {
      this.current = ev.time;
      ev.fn();
    }
  }
}

export interface SimJob {
  /** BullMQ priority: lower runs first; FIFO within one priority. */
  priority: number;
  /** Seconds the job keeps its worker slot. */
  holdSec: number;
  /** Called when a worker picks the job up, with how long it waited in the queue. */
  onStart?: (waitSec: number) => void;
  /** Called when the job finishes and its slot is released. */
  onDone: () => void;
}

interface QueuedJob {
  job: SimJob;
  enqueuedAt: number;
}

/** A FIFO bucket that pops from a moving head instead of shifting the array on every pop. */
interface Bucket {
  jobs: QueuedJob[];
  head: number;
}

const COMPACT_AFTER = 1024;

export interface LaneStats {
  lane: string;
  concurrency: number;
  jobs: number;
  /** Most jobs waiting (not running) at any instant. */
  peakDepth: number;
  busySec: number;
}

/** One BullMQ queue served by `concurrency` worker slots. */
export class SimLane {
  private busy = 0;
  private waiting = 0;
  private peakDepth = 0;
  private jobs = 0;
  private busySec = 0;
  private readonly buckets = new Map<number, Bucket>();
  /** Priorities with a bucket, ascending; tiny (three values in practice). */
  private readonly priorities: number[] = [];

  constructor(
    private readonly loop: EventLoop,
    readonly name: string,
    readonly concurrency: number,
  ) {}

  enqueue(job: SimJob): void {
    let bucket = this.buckets.get(job.priority);
    if (!bucket) {
      bucket = { jobs: [], head: 0 };
      this.buckets.set(job.priority, bucket);
      this.priorities.push(job.priority);
      this.priorities.sort((a, b) => a - b);
    }
    bucket.jobs.push({ job, enqueuedAt: this.loop.now });
    this.waiting += 1;
    this.tryStart();
    this.peakDepth = Math.max(this.peakDepth, this.waiting);
  }

  stats(): LaneStats {
    return {
      lane: this.name,
      concurrency: this.concurrency,
      jobs: this.jobs,
      peakDepth: this.peakDepth,
      busySec: this.busySec,
    };
  }

  private next(): QueuedJob | undefined {
    for (const priority of this.priorities) {
      const bucket = this.buckets.get(priority);
      if (!bucket || bucket.head >= bucket.jobs.length) continue;
      const queued = bucket.jobs[bucket.head];
      bucket.head += 1;
      if (bucket.head > COMPACT_AFTER && bucket.head * 2 > bucket.jobs.length) {
        bucket.jobs = bucket.jobs.slice(bucket.head);
        bucket.head = 0;
      }
      return queued;
    }
    return undefined;
  }

  private tryStart(): void {
    while (this.busy < this.concurrency && this.waiting > 0) {
      const queued = this.next();
      if (!queued) return;
      this.waiting -= 1;
      this.busy += 1;
      const { job } = queued;
      job.onStart?.(this.loop.now - queued.enqueuedAt);
      this.loop.after(job.holdSec, () => {
        this.busy -= 1;
        this.jobs += 1;
        this.busySec += job.holdSec;
        // The finished job enqueues its successor before the slot is re-filled, as a BullMQ
        // processor does when it adds the next job just before returning.
        job.onDone();
        this.tryStart();
      });
    }
  }
}
