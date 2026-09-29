import { ConfigurationError } from '../../errors';

// Deployment: single VPS. A process-wide cap on concurrent FFmpeg/ffprobe children. Every FFmpeg
// call goes through media-probe.ts `run()` (probe, blackdetect, loudness, scenes, frames, library
// previews, mastering, overlay pre-render, thumbnails), so capping there bounds the memory and CPU
// FFmpeg can take however many jobs the worker runs at once. On a 2 GB server the worker runs every
// queue in one process and STUDIO_FFMPEG_MAX_CONCURRENT=1 keeps FFmpeg to one child at a time.
// Unset = no cap (the previous behaviour; bigger hosts and the split per-queue workers).

export const FFMPEG_CONCURRENCY_ENV = 'STUDIO_FFMPEG_MAX_CONCURRENT';
const MAX_FFMPEG_CONCURRENCY = 64;

export interface ConcurrencyLimiter {
  /** Runs `task` once fewer than `max` tasks are running; first come, first served. */
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

/** A FIFO semaphore. `max` undefined = unlimited (tasks start at once). */
export function createConcurrencyLimiter(max: number | undefined): ConcurrencyLimiter {
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
    throw new ConfigurationError('concurrency limit must be a positive whole number');
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  const acquire = (): Promise<void> => {
    if (max === undefined || active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

/** STUDIO_FFMPEG_MAX_CONCURRENT: empty = unlimited, else a whole number 1–64. */
export function ffmpegConcurrencyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env[FFMPEG_CONCURRENCY_ENV]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > MAX_FFMPEG_CONCURRENCY) {
    throw new ConfigurationError(
      `${FFMPEG_CONCURRENCY_ENV} must be a whole number from 1 to ${MAX_FFMPEG_CONCURRENCY}`,
    );
  }
  return n;
}

const limiters = new Map<string, ConcurrencyLimiter>();

/**
 * The shared limiter for this process's FFmpeg children, keyed by the configured value so every
 * caller in the process shares one queue (a changed value, e.g. in tests, gets a fresh limiter).
 */
export function ffmpegLimiter(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConcurrencyLimiter {
  const max = ffmpegConcurrencyFromEnv(env);
  const key = String(max ?? 'unlimited');
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = createConcurrencyLimiter(max);
    limiters.set(key, limiter);
  }
  return limiter;
}
