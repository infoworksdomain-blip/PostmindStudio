import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import {
  createConcurrencyLimiter,
  ffmpegConcurrencyFromEnv,
  ffmpegLimiter,
  FFMPEG_CONCURRENCY_ENV,
} from './process-limit';
import { run } from './media-probe';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('createConcurrencyLimiter', () => {
  it('runs at most `max` tasks at once, in arrival order', async () => {
    const limiter = createConcurrencyLimiter(1);
    const order: string[] = [];
    const first = deferred();
    const a = limiter.run(async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = limiter.run(async () => {
      order.push('b:start');
    });
    const c = limiter.run(async () => {
      order.push('c:start');
    });
    await Promise.resolve();
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(2);
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'c:start']);
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('frees the slot when a task fails, and passes the error on', async () => {
    const limiter = createConcurrencyLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(() => Promise.resolve('next'))).resolves.toBe('next');
    expect(limiter.active).toBe(0);
  });

  it('with max 2 lets two run together', async () => {
    const limiter = createConcurrencyLimiter(2);
    const gate = deferred();
    const tasks = [1, 2, 3].map(() => limiter.run(() => gate.promise));
    await Promise.resolve();
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(1);
    gate.resolve();
    await Promise.all(tasks);
  });

  it('is unlimited when max is undefined', async () => {
    const limiter = createConcurrencyLimiter(undefined);
    const gate = deferred();
    const tasks = Array.from({ length: 10 }, () => limiter.run(() => gate.promise));
    await Promise.resolve();
    expect(limiter.active).toBe(10);
    expect(limiter.waiting).toBe(0);
    gate.resolve();
    await Promise.all(tasks);
  });

  it('refuses a limit that is not a positive whole number', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(ConfigurationError);
    expect(() => createConcurrencyLimiter(1.5)).toThrow(ConfigurationError);
  });
});

describe('ffmpegConcurrencyFromEnv', () => {
  it('is unlimited when unset or empty', () => {
    expect(ffmpegConcurrencyFromEnv({})).toBeUndefined();
    expect(ffmpegConcurrencyFromEnv({ [FFMPEG_CONCURRENCY_ENV]: '  ' })).toBeUndefined();
  });

  it('reads a whole number from 1 to 64', () => {
    expect(ffmpegConcurrencyFromEnv({ [FFMPEG_CONCURRENCY_ENV]: '1' })).toBe(1);
    expect(ffmpegConcurrencyFromEnv({ [FFMPEG_CONCURRENCY_ENV]: ' 64 ' })).toBe(64);
  });

  it.each(['0', '65', '-1', '1.5', 'one'])('refuses %s', (value) => {
    expect(() => ffmpegConcurrencyFromEnv({ [FFMPEG_CONCURRENCY_ENV]: value })).toThrow(
      ConfigurationError,
    );
  });
});

describe('ffmpegLimiter', () => {
  it('returns one shared limiter per configured value', () => {
    const one = ffmpegLimiter({ [FFMPEG_CONCURRENCY_ENV]: '1' });
    expect(ffmpegLimiter({ [FFMPEG_CONCURRENCY_ENV]: '1' })).toBe(one);
    expect(ffmpegLimiter({ [FFMPEG_CONCURRENCY_ENV]: '2' })).not.toBe(one);
    expect(ffmpegLimiter({})).toBe(ffmpegLimiter({}));
  });
});

describe('media-probe run() honours STUDIO_FFMPEG_MAX_CONCURRENT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The Node binary stands in for ffmpeg: each child drops a marker file in a shared folder, and
  // reports the most markers it saw (itself included) while it ran.
  const script = `const fs=require('fs'),p=require('path');const d=process.argv[1];
    const me=p.join(d,String(process.pid));fs.writeFileSync(me,'');const seen=fs.readdirSync(d).length;
    setTimeout(()=>{const later=fs.readdirSync(d).length;fs.unlinkSync(me);
    process.stdout.write(String(Math.max(seen,later)));},200);`;

  async function peakOverlap(limit: string | undefined): Promise<number> {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-limit-'));
    vi.stubEnv(FFMPEG_CONCURRENCY_ENV, limit ?? '');
    const results = await Promise.all(
      [1, 2, 3].map(() => run(process.execPath, ['-e', script, dir], 10_000)),
    );
    return Math.max(...results.map((r) => Number(r.stdout)));
  }

  it('runs one child at a time with a limit of 1', async () => {
    expect(await peakOverlap('1')).toBe(1);
  });

  it('runs children together without a limit', async () => {
    expect(await peakOverlap(undefined)).toBeGreaterThan(1);
  });

  it('rejects (does not throw) on an invalid setting', async () => {
    vi.stubEnv(FFMPEG_CONCURRENCY_ENV, 'many');
    await expect(run(process.execPath, ['-e', ''], 1_000)).rejects.toThrow(ConfigurationError);
  });
});
