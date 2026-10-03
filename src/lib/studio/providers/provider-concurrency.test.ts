import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import {
  ACQUIRE_SLOT_SCRIPT,
  concurrencyEnvName,
  concurrencyLimitsFromEnv,
  createMemoryProviderConcurrencyLimiter,
  createRedisProviderConcurrencyLimiter,
  defaultShare,
  parseConcurrency,
  providerConcurrencyFromEnv,
  providerOverflowFromEnv,
  RELEASE_SLOT_SCRIPT,
  SLOT_RETRY_MS,
  slotRetryMs,
} from './provider-concurrency';

// 20.29: per-provider in-flight caps with a fair share per organisation.

const LEASE = 60_000;

describe('concurrency limits from env', () => {
  it('names the variable after the provider id', () => {
    expect(concurrencyEnvName('seedance')).toBe('STUDIO_PROVIDER_CONCURRENCY_SEEDANCE');
    expect(concurrencyEnvName('elevenlabs-music')).toBe(
      'STUDIO_PROVIDER_CONCURRENCY_ELEVENLABS_MUSIC',
    );
  });

  it('has documented defaults for Seedance and Kling only', () => {
    const limits = concurrencyLimitsFromEnv({});
    expect(limits('seedance')).toEqual({ max: 3, perOrganisation: 2 });
    expect(limits('kling')).toEqual({ max: 20, perOrganisation: 10 });
    expect(limits('veo')).toBeUndefined();
  });

  it('parses overrides, shares and "off"', () => {
    expect(parseConcurrency('10', 'X')).toEqual({ max: 10, perOrganisation: 5 });
    expect(parseConcurrency(' 10 , org = 3 ', 'X')).toEqual({ max: 10, perOrganisation: 3 });
    expect(parseConcurrency('off', 'X')).toBeUndefined();
    expect(parseConcurrency('0', 'X')).toBeUndefined();
    expect(defaultShare(1)).toBe(1);
    const limits = concurrencyLimitsFromEnv({
      STUDIO_PROVIDER_CONCURRENCY_SEEDANCE: '10',
      STUDIO_PROVIDER_CONCURRENCY_KLING: 'off',
      STUDIO_PROVIDER_CONCURRENCY_VEO: '4,org=4',
    });
    expect(limits('seedance')).toEqual({ max: 10, perOrganisation: 5 });
    expect(limits('kling')).toBeUndefined();
    expect(limits('veo')).toEqual({ max: 4, perOrganisation: 4 });
  });

  it.each(['-1', 'many', '1001', '3,org=4', '3,org=0', '2.5'])('rejects %s at start-up', (raw) => {
    expect(() => concurrencyLimitsFromEnv({ STUDIO_PROVIDER_CONCURRENCY_LUMA: raw })).toThrow(
      ConfigurationError,
    );
  });

  it('reads the overflow policy', () => {
    expect(providerOverflowFromEnv({})).toBe('queue');
    expect(providerOverflowFromEnv({ STUDIO_PROVIDER_OVERFLOW: 'Failover' })).toBe('failover');
    expect(() => providerOverflowFromEnv({ STUDIO_PROVIDER_OVERFLOW: 'skip' })).toThrow(
      ConfigurationError,
    );
  });

  it('retries a full provider after 10–20 s', () => {
    expect(slotRetryMs(() => 0)).toBe(SLOT_RETRY_MS);
    expect(slotRetryMs(() => 0.999)).toBeLessThan(2 * SLOT_RETRY_MS);
  });
});

describe('memory limiter', () => {
  const limits = () => ({ max: 3, perOrganisation: 2 });

  it('holds the account cap and gives slots back on release', async () => {
    const limiter = createMemoryProviderConcurrencyLimiter(limits);
    const slots = await Promise.all(
      ['a', 'b', 'c'].map((org) =>
        limiter.acquire({ providerId: 'seedance', organisationId: org, leaseMs: LEASE }),
      ),
    );
    expect(slots.every((s) => s.acquired)).toBe(true);
    const full = await limiter.acquire({
      providerId: 'seedance',
      organisationId: 'd',
      leaseMs: LEASE,
    });
    expect(full).toMatchObject({ acquired: false, reason: 'provider_full' });
    const first = slots[0];
    if (first?.acquired) await first.release();
    expect(limiter.inFlight('seedance')).toBe(2);
    const next = await limiter.acquire({
      providerId: 'seedance',
      organisationId: 'd',
      leaseMs: LEASE,
    });
    expect(next.acquired).toBe(true);
  });

  it('keeps one organisation to its share so another can always start', async () => {
    const limiter = createMemoryProviderConcurrencyLimiter(limits);
    const take = (org: string) =>
      limiter.acquire({ providerId: 'seedance', organisationId: org, leaseMs: LEASE });
    expect((await take('heavy')).acquired).toBe(true);
    expect((await take('heavy')).acquired).toBe(true);
    expect(await take('heavy')).toMatchObject({ acquired: false, reason: 'organisation_share' });
    expect((await take('light')).acquired).toBe(true);
    expect(limiter.inFlight('seedance', 'heavy')).toBe(2);
  });

  it('gives a BYOC organisation its own account without a share', async () => {
    const limiter = createMemoryProviderConcurrencyLimiter(limits);
    for (let i = 0; i < 3; i += 1) {
      const slot = await limiter.acquire({
        providerId: 'seedance',
        organisationId: 'own',
        byoc: true,
        leaseMs: LEASE,
      });
      expect(slot.acquired).toBe(true);
    }
    expect(limiter.inFlight('seedance')).toBe(0);
  });

  it('expires leases a dead worker never released', async () => {
    let now = 0;
    const limiter = createMemoryProviderConcurrencyLimiter(
      () => ({ max: 1, perOrganisation: 1 }),
      () => now,
    );
    await limiter.acquire({ providerId: 'kling', organisationId: 'a', leaseMs: 1_000 });
    expect(
      (await limiter.acquire({ providerId: 'kling', organisationId: 'b', leaseMs: 1_000 }))
        .acquired,
    ).toBe(false);
    now = 1_001;
    expect(
      (await limiter.acquire({ providerId: 'kling', organisationId: 'b', leaseMs: 1_000 }))
        .acquired,
    ).toBe(true);
  });

  it('does not limit providers without a cap', async () => {
    const limiter = createMemoryProviderConcurrencyLimiter(() => undefined);
    const slot = await limiter.acquire({ providerId: 'veo', organisationId: 'a', leaseMs: LEASE });
    expect(slot.acquired).toBe(true);
    if (slot.acquired) await slot.release();
  });
});

describe('Redis limiter', () => {
  const logger = { warn: vi.fn() };

  it('runs the acquire script on the account and organisation keys, then releases both', async () => {
    const evalFn = vi.fn(async (..._args: string[]) => 1 as unknown);
    const limiter = createRedisProviderConcurrencyLimiter({
      client: { eval: (script, n, ...rest) => evalFn(script, String(n), ...rest) },
      limits: () => ({ max: 3, perOrganisation: 2 }),
      logger,
      now: () => 1_000,
    });
    const slot = await limiter.acquire({
      providerId: 'seedance',
      organisationId: 'o1',
      leaseMs: 500,
    });
    expect(slot.acquired).toBe(true);
    const [script, n, account, org, now, , max, share, expiry] = evalFn.mock.calls[0] ?? [];
    expect([script, n, account, org, now, max, share, expiry]).toEqual([
      ACQUIRE_SLOT_SCRIPT,
      '2',
      'studio:pconc:seedance',
      'studio:pconc:seedance:org:o1',
      '1000',
      '3',
      '2',
      '1500',
    ]);
    if (slot.acquired) await slot.release();
    expect(evalFn.mock.calls[1]?.slice(0, 4)).toEqual([
      RELEASE_SLOT_SCRIPT,
      '2',
      'studio:pconc:seedance',
      'studio:pconc:seedance:org:o1',
    ]);
  });

  it('reports a full account and an organisation at its share', async () => {
    for (const [code, reason] of [
      [0, 'provider_full'],
      [-1, 'organisation_share'],
    ] as const) {
      const limiter = createRedisProviderConcurrencyLimiter({
        client: { eval: async () => code },
        limits: () => ({ max: 3, perOrganisation: 2 }),
        logger,
      });
      expect(
        await limiter.acquire({ providerId: 'seedance', organisationId: 'o', leaseMs: 1 }),
      ).toMatchObject({ acquired: false, reason });
    }
  });

  it('uses one BYOC key, and fails open (warning once) when Redis errors', async () => {
    const evalFn = vi.fn(async () => {
      throw new Error('redis down');
    });
    const warn = vi.fn();
    const limiter = createRedisProviderConcurrencyLimiter({
      client: { eval: evalFn },
      limits: () => ({ max: 1, perOrganisation: 1 }),
      logger: { warn },
    });
    const a = await limiter.acquire({
      providerId: 'kling',
      organisationId: 'o',
      byoc: true,
      leaseMs: 1,
    });
    const b = await limiter.acquire({ providerId: 'kling', organisationId: 'o', leaseMs: 1 });
    expect(a.acquired && b.acquired).toBe(true);
    expect(evalFn.mock.calls[0]).toEqual(expect.arrayContaining([1, 'studio:pconc:kling:byoc:o']));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('a failed release only warns (the lease expires on its own)', async () => {
    let calls = 0;
    const warn = vi.fn();
    const limiter = createRedisProviderConcurrencyLimiter({
      client: {
        eval: async () => {
          calls += 1;
          if (calls > 1) throw new Error('gone');
          return 1;
        },
      },
      limits: () => ({ max: 1, perOrganisation: 1 }),
      logger: { warn },
    });
    const slot = await limiter.acquire({ providerId: 'kling', organisationId: 'o', leaseMs: 1 });
    if (slot.acquired) await expect(slot.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is built only with Redis', () => {
    const make = vi.fn(() => ({ eval: async () => 1 }));
    expect(providerConcurrencyFromEnv({}, make, logger)).toBeUndefined();
    expect(providerConcurrencyFromEnv({ REDIS_URL: 'redis://x/3' }, make, logger)).toBeDefined();
    expect(make).toHaveBeenCalledOnce();
  });
});
