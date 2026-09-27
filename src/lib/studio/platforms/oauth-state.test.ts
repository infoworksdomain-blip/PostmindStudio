import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryOAuthStateStore,
  createRedisOAuthStateStore,
  OAUTH_STATE_TTL_SEC,
} from './oauth-state';
import type { OAuthPending } from './oauth-state';

const redisInstances: Array<{ set: ReturnType<typeof vi.fn>; getdel: ReturnType<typeof vi.fn> }> =
  [];

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => {
    const instance = { set: vi.fn(async () => 'OK'), getdel: vi.fn(async () => null) };
    redisInstances.push(instance);
    return instance;
  }),
}));

const pending: OAuthPending = {
  organisationId: 'org-1',
  userId: 'user-1',
  businessId: 'biz-1',
  platform: 'tiktok',
  codeVerifier: 'verifier-1',
  returnTo: '/dashboard',
};

describe('createMemoryOAuthStateStore', () => {
  it('creates a random state handle and consume returns the stored pending flow', async () => {
    const store = createMemoryOAuthStateStore();
    const state = await store.create(pending);
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
    await expect(store.consume(state)).resolves.toEqual(pending);
  });

  it('generates a different state handle on each call', async () => {
    const store = createMemoryOAuthStateStore();
    const a = await store.create(pending);
    const b = await store.create(pending);
    expect(a).not.toBe(b);
  });

  it('is single-use: consuming the same state twice returns null the second time', async () => {
    const store = createMemoryOAuthStateStore();
    const state = await store.create(pending);
    await store.consume(state);
    await expect(store.consume(state)).resolves.toBeNull();
  });

  it('returns null for an unknown state', async () => {
    const store = createMemoryOAuthStateStore();
    await expect(store.consume('unknown-state')).resolves.toBeNull();
  });

  it('returns null and deletes the entry once it has expired', async () => {
    let now = 0;
    const store = createMemoryOAuthStateStore(() => now);
    const state = await store.create(pending);
    now += OAUTH_STATE_TTL_SEC * 1000 + 1;
    await expect(store.consume(state)).resolves.toBeNull();
    // Even "before" expiry from a caller's perspective, it was already deleted on first consume.
    await expect(store.consume(state)).resolves.toBeNull();
  });

  it('returns the pending flow right up to (but not after) the TTL boundary', async () => {
    let now = 0;
    const store = createMemoryOAuthStateStore(() => now);
    const state = await store.create(pending);
    now += OAUTH_STATE_TTL_SEC * 1000 - 1;
    await expect(store.consume(state)).resolves.toEqual(pending);
  });
});

describe('createRedisOAuthStateStore', () => {
  it('sets a JSON payload with the state TTL and consumes via GETDEL', async () => {
    const store = createRedisOAuthStateStore({ host: 'localhost' });
    const instance = redisInstances[redisInstances.length - 1]!;
    const state = await store.create(pending);
    expect(instance.set).toHaveBeenCalledWith(
      `studio:oauth:${state}`,
      JSON.stringify(pending),
      'EX',
      OAUTH_STATE_TTL_SEC,
    );
    instance.getdel.mockResolvedValueOnce(JSON.stringify(pending));
    await expect(store.consume(state)).resolves.toEqual(pending);
    expect(instance.getdel).toHaveBeenCalledWith(`studio:oauth:${state}`);
  });

  it('returns null when GETDEL finds nothing', async () => {
    const store = createRedisOAuthStateStore({ host: 'localhost' });
    const instance = redisInstances[redisInstances.length - 1]!;
    instance.getdel.mockResolvedValueOnce(null);
    await expect(store.consume('missing-state')).resolves.toBeNull();
  });
});
