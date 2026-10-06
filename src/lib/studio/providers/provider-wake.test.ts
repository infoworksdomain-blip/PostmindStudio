import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryProviderWake,
  createRedisProviderWake,
  providerWakeFromEnv,
  waitForNextPoll,
  WAKE_TTL_MS,
  wakeKey,
} from './provider-wake';

const logger = { warn: vi.fn() };

describe('provider wake flags (23.1)', () => {
  it('a signal is consumed once', async () => {
    const wake = createMemoryProviderWake();
    await wake.signal('shotstack', 'r1');
    expect(await wake.consume('shotstack', 'r2')).toBe(false);
    expect(await wake.consume('shotstack', 'r1')).toBe(true);
    expect(await wake.consume('shotstack', 'r1')).toBe(false);
  });

  it('the Redis flags expire and are read-and-deleted in one script', async () => {
    const evalFn = vi.fn(
      async (_script: string, _numKeys: number, ..._args: string[]): Promise<unknown> => 1,
    );
    const wake = createRedisProviderWake({ client: { eval: evalFn }, logger });
    await wake.signal('shotstack', 'r1');
    expect(evalFn).toHaveBeenCalledWith(
      expect.stringContaining("'PX'"),
      1,
      wakeKey('shotstack', 'r1'),
      String(WAKE_TTL_MS),
    );
    expect(await wake.consume('shotstack', 'r1')).toBe(true);
    expect(evalFn.mock.calls[1]?.[0]).toContain("'DEL'");
  });

  it('a Redis error reads as "not woken" (the fallback poll still runs)', async () => {
    const wake = createRedisProviderWake({
      client: {
        eval: async () => {
          throw new Error('redis down');
        },
      },
      logger,
    });
    expect(await wake.consume('shotstack', 'r1')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is only built with Redis', () => {
    const make = () => ({ eval: async () => 0 });
    expect(providerWakeFromEnv({}, make, logger)).toBeUndefined();
    expect(providerWakeFromEnv({ REDIS_URL: 'redis://x/3' }, make, logger)).toBeDefined();
  });
});

describe('waitForNextPoll (23.1)', () => {
  it('sleeps once without wake flags', async () => {
    const sleep = vi.fn(async () => undefined);
    expect(await waitForNextPoll({ sleep }, { providerId: 's', providerJobId: 'r' }, 5_000)).toBe(
      false,
    );
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
  });

  it('returns as soon as the job is woken', async () => {
    const wake = createMemoryProviderWake();
    let slept = 0;
    const sleep = async (ms: number) => {
      slept += ms;
      if (slept === 3_000) await wake.signal('s', 'r');
    };
    expect(
      await waitForNextPoll({ sleep, wake }, { providerId: 's', providerJobId: 'r' }, 20_000),
    ).toBe(true);
    expect(slept).toBe(3_000);
  });

  it('waits the whole interval when nobody wakes it', async () => {
    let slept = 0;
    const sleep = async (ms: number) => {
      slept += ms;
    };
    const wake = createMemoryProviderWake();
    expect(
      await waitForNextPoll({ sleep, wake }, { providerId: 's', providerJobId: 'r' }, 2_500),
    ).toBe(false);
    expect(slept).toBe(2_500);
  });
});
