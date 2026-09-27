import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, RateLimitError } from '../../errors';
import { StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import { setApiDeps, type ApiDeps } from './context';
import { createMemoryIdempotencyStore } from './idempotency';
import {
  createMemoryRateLimitStore,
  createRateLimiter,
  rateLimitsFromEnv,
  type RateLimitStore,
} from './rate-limit';
import { withStudioRoute } from './route';

const limits = { readsPerMin: 3, writesPerMin: 1, orgPerMin: 5 };
const who = (userId = 'u1', method = 'GET') => ({ organisationId: 'org-1', userId, method });

describe('createRateLimiter', () => {
  it('allows reads up to the per-user limit, then 429s with Retry-After', async () => {
    let t = 0;
    const limiter = createRateLimiter(
      createMemoryRateLimitStore(() => t),
      limits,
    );
    for (let i = 0; i < 3; i++) await limiter.check(who());
    const err = await limiter.check(who()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSec).toBe(60);
    expect((err as RateLimitError).details).toMatchObject({ scope: 'user', limit: 3 });

    t = 61_000; // next window
    await expect(limiter.check(who())).resolves.toBeUndefined();
  });

  it('counts writes separately from reads, with their own lower limit', async () => {
    const limiter = createRateLimiter(createMemoryRateLimitStore(), limits);
    await limiter.check(who('u1', 'POST'));
    await expect(limiter.check(who('u1', 'PATCH'))).rejects.toBeInstanceOf(RateLimitError);
    await expect(limiter.check(who('u1', 'GET'))).resolves.toBeUndefined();
  });

  it('applies an organisation-wide limit across users', async () => {
    const limiter = createRateLimiter(createMemoryRateLimitStore(), limits);
    for (const u of ['a', 'b', 'c', 'd', 'e']) await limiter.check(who(u));
    const err = await limiter.check(who('f')).catch((e: unknown) => e);
    expect((err as RateLimitError).details).toMatchObject({ scope: 'organisation' });
  });

  it('keeps organisations independent', async () => {
    const limiter = createRateLimiter(createMemoryRateLimitStore(), limits);
    await limiter.check(who('u1', 'POST'));
    await expect(
      limiter.check({ organisationId: 'org-2', userId: 'u1', method: 'POST' }),
    ).resolves.toBeUndefined();
  });

  it('fails open (and reports) when the store is unavailable', async () => {
    const broken: RateLimitStore = { hit: async () => Promise.reject(new Error('redis down')) };
    const onStoreError = vi.fn();
    const limiter = createRateLimiter(broken, limits, { onStoreError });
    await expect(limiter.check(who())).resolves.toBeUndefined();
    expect(onStoreError).toHaveBeenCalledOnce();
  });
});

describe('rateLimitsFromEnv', () => {
  it('uses defaults and accepts overrides', () => {
    expect(rateLimitsFromEnv({})).toEqual({ readsPerMin: 600, writesPerMin: 120, orgPerMin: 3000 });
    expect(rateLimitsFromEnv({ STUDIO_RATE_LIMIT_WRITES_PER_MIN: '30' }).writesPerMin).toBe(30);
  });

  it('rejects nonsense values', () => {
    expect(() => rateLimitsFromEnv({ STUDIO_RATE_LIMIT_ORG_PER_MIN: '0' })).toThrow(
      ConfigurationError,
    );
    expect(() => rateLimitsFromEnv({ STUDIO_RATE_LIMIT_READS_PER_MIN: 'lots' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('withStudioRoute rate limiting', () => {
  afterEach(() => setApiDeps(undefined));

  const tenantCtx: TenantContext = {
    userId: 'u1',
    organisationId: 'org-1',
    organisation: { id: 'org-1' },
    memberships: [{ organisationId: 'org-1', role: 'owner' }],
    capabilities: ['studio:*'],
  };

  it('returns 429 with Retry-After once the limit is hit, before the handler runs', async () => {
    const handler = vi.fn(async () => ({ body: { hello: 'world' } }));
    setApiDeps({
      resolveTenant: async () => tenantCtx,
      idempotency: createMemoryIdempotencyStore(),
      rateLimiter: createRateLimiter(createMemoryRateLimitStore(), limits),
      audit: () => undefined,
      logger: pino({ level: 'silent' }),
      now: Date.now,
    } as unknown as ApiDeps);
    const route = withStudioRoute(StudioCapability.ProjectRead, handler);
    const next = { params: Promise.resolve({}) };
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await route(new Request('http://studio.test/api/studio/projects'), next);
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(last?.headers.get('retry-after')).toBe('60');
    expect(((await last?.json()) as { error: string }).error).toBe('rate_limited');
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
