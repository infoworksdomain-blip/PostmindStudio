import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ConfigurationError } from '../../errors';
import { httpJson } from './http';
import { usdToGbpRateFromEnv, usdToPence } from './pricing';
import { classifyHttpStatus, classifyNetworkError } from './provider-errors';
import { createProviderRegistry } from './registry';
import { SyncJobStore } from './sync-jobs';
import { StubAdapter } from './test-adapter';

afterEach(() => vi.unstubAllEnvs());

describe('registry', () => {
  const runway = new StubAdapter('runway', ['text_to_video', 'image_to_video']);
  const luma = new StubAdapter('luma', ['text_to_video']);
  const registry = createProviderRegistry([runway, luma]);

  it('looks adapters up by id and capability', () => {
    expect(registry.getAdapter('runway')).toBe(runway);
    expect(registry.findAdapter('veo')).toBeUndefined();
    expect(registry.getAdaptersByCapability('text_to_video')).toEqual([runway, luma]);
    expect(registry.getAdaptersByCapability('image_to_video')).toEqual([runway]);
    expect(registry.list()).toHaveLength(2);
  });

  it('throws for unconfigured ids and duplicate registration', () => {
    expect(() => registry.getAdapter('veo')).toThrow(ConfigurationError);
    expect(() => createProviderRegistry([runway, runway])).toThrow(/registered twice/);
  });
});

describe('pricing', () => {
  it('converts USD to whole pence, rounding up and ignoring float noise', () => {
    expect(usdToPence(0.6, 0.75)).toBe(45);
    expect(usdToPence(0.1 + 0.2, 1)).toBe(30);
    expect(usdToPence(0.0001, 0.75)).toBe(1);
    expect(usdToPence(0, 0.75)).toBe(0);
  });

  it('reads and validates the FX rate from env', () => {
    vi.stubEnv('STUDIO_USD_TO_GBP_RATE', '0.79');
    expect(usdToGbpRateFromEnv()).toBe(0.79);
    for (const bad of ['abc', '0', '-1', '9']) {
      vi.stubEnv('STUDIO_USD_TO_GBP_RATE', bad);
      expect(() => usdToGbpRateFromEnv()).toThrow(ConfigurationError);
    }
  });
});

describe('SyncJobStore', () => {
  it('returns parked results until the TTL passes', () => {
    let now = 0;
    const store = new SyncJobStore('anthropic', () => now, 1000);
    const id = store.put({ state: 'succeeded', output: { metadata: { ok: true } } });
    expect(id).toMatch(/^anthropic_/);
    expect(store.get(id).state).toBe('succeeded');
    now = 1000;
    expect(store.get(id)).toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('evicts expired entries on put and supports delete', () => {
    let now = 0;
    const store = new SyncJobStore('x', () => now, 10);
    const old = store.put({ state: 'running' });
    now = 20;
    const fresh = store.put({ state: 'running' });
    store.delete(fresh);
    expect(store.get(old).state).toBe('failed');
    expect(store.get(fresh).state).toBe('failed');
  });
});

describe('provider error classification', () => {
  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [402, 'insufficient_credits', false],
    [408, 'timeout', true],
    [409, 'provider_unavailable', true],
    [429, 'rate_limited', true],
    [500, 'provider_unavailable', true],
    [529, 'provider_unavailable', true],
    [404, 'invalid_request', false],
    [302, 'unknown', false],
  ])('HTTP %i → %s', (status, errorClass, retryable) => {
    expect(classifyHttpStatus(status)).toEqual({ errorClass, retryable });
  });

  it('classifies network errors', () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const abort = Object.assign(new Error('a'), { name: 'AbortError' });
    expect(classifyNetworkError(timeout).errorClass).toBe('timeout');
    expect(classifyNetworkError(abort).errorClass).toBe('timeout');
    expect(classifyNetworkError(new TypeError('reset'))).toEqual({
      errorClass: 'provider_unavailable',
      retryable: true,
    });
  });
});

describe('httpJson', () => {
  const options = (f: typeof fetch) => ({ providerId: 'p', fetchImpl: f, timeoutMs: 1000 });

  it('parses JSON, tolerates empty and non-JSON bodies', async () => {
    const { fetch } = fakeFetch(
      json({ a: 1 }),
      new Response(null, { status: 204 }),
      new Response('plain', { status: 200 }),
    );
    expect((await httpJson('u', {}, options(fetch))).body).toEqual({ a: 1 });
    expect((await httpJson('u', {}, options(fetch))).body).toBeUndefined();
    expect((await httpJson('u', {}, options(fetch))).body).toBe('plain');
  });

  it('turns non-2xx into ProviderErrors with the status in details', async () => {
    const { fetch } = fakeFetch(json({ error: 'x' }, 503));
    await expect(httpJson('u', {}, options(fetch))).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      message: 'HTTP 503',
      details: expect.objectContaining({ status: 503 }),
    });
  });
});
