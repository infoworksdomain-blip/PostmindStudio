import { describe, expect, it, vi } from 'vitest';
import { createMemoryAuthRateLimitStore, createRedisAuthRateLimitStore } from './rate-limit-store';

describe('auth rate-limit stores (Phase 18 §5.2)', () => {
  it('memory: a fixed window per key that resets', async () => {
    let t = 0;
    const store = createMemoryAuthRateLimitStore(() => t);
    const rule = { window: 60, max: 2 };
    expect(await store.consume('k', rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await store.consume('k', rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await store.consume('k', rule)).toEqual({ allowed: false, retryAfter: 60 });
    expect((await store.consume('other', rule)).allowed).toBe(true);
    t = 61_000;
    expect((await store.consume('k', rule)).allowed).toBe(true);
  });

  it('redis: one atomic script per consume, prefixed key, retry-after from the TTL', async () => {
    const evalFn = vi.fn().mockResolvedValueOnce([1, 60_000]).mockResolvedValueOnce([6, 12_345]);
    const store = createRedisAuthRateLimitStore({ eval: evalFn } as never);
    expect(await store.consume('1.2.3.4/sign-in/email', { window: 60, max: 5 })).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(await store.consume('1.2.3.4/sign-in/email', { window: 60, max: 5 })).toEqual({
      allowed: false,
      retryAfter: 13,
    });
    const [script, keys, key, windowMs] = evalFn.mock.calls[0] as [string, number, string, string];
    expect(script).toContain('INCR');
    expect(keys).toBe(1);
    expect(key).toBe('studio:auth-rl:1.2.3.4/sign-in/email');
    expect(windowMs).toBe('60000');
  });

  it('redis: fails open when Valkey is down, and reports it', async () => {
    const onError = vi.fn();
    const store = createRedisAuthRateLimitStore(
      { eval: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as never,
      { onError },
    );
    expect(await store.consume('k', { window: 60, max: 1 })).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(onError).toHaveBeenCalledOnce();
  });
});
