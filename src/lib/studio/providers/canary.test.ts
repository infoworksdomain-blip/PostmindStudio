import { describe, expect, it, vi } from 'vitest';
import {
  buildCanaryAdapter,
  canaryAnnotations,
  deprecationSignal,
  PROVIDER_CANARY_ENV,
  providerCanaryKeys,
  recordingFetch,
  runProviderCanary,
  type DeprecationSignal,
} from './canary';

// BACKLOG 15.D10 — provider canary: health checks through a fetch that records
// Deprecation / Sunset / Link headers (offline, fake fetch).

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('deprecationSignal', () => {
  it('reads RFC 9745 Deprecation, RFC 8594 Sunset and deprecation/sunset Link relations', () => {
    const res = json(
      {},
      {
        deprecation: '@1767225600',
        sunset: 'Wed, 01 Jul 2027 00:00:00 GMT',
        link: '<https://docs.example/migrate>; rel="deprecation"; type="text/html"',
      },
    );
    expect(deprecationSignal('runway', 'GET', 'https://api.example/v1/x', res)).toEqual({
      providerId: 'runway',
      method: 'GET',
      url: 'https://api.example/v1/x',
      status: 200,
      deprecation: '@1767225600',
      sunset: 'Wed, 01 Jul 2027 00:00:00 GMT',
      link: '<https://docs.example/migrate>; rel="deprecation"; type="text/html"',
    });
  });

  it('ignores responses without signals and unrelated Link relations', () => {
    expect(deprecationSignal('x', 'GET', 'u', json({}))).toBeNull();
    expect(deprecationSignal('x', 'GET', 'u', json({}, { link: '<a>; rel="next"' }))).toBeNull();
  });
});

describe('recordingFetch', () => {
  it('passes responses through and records signals without the query string', async () => {
    const sink: DeprecationSignal[] = [];
    const base = vi.fn().mockResolvedValue(json({ ok: true }, { sunset: 'soon' }));
    const wrapped = recordingFetch('openai', base as unknown as typeof fetch, sink);
    const res = await wrapped('https://api.example/v1/models?key=secret', { method: 'post' });
    expect(await res.json()).toEqual({ ok: true });
    expect(sink).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: 'https://api.example/v1/models',
        sunset: 'soon',
      }),
    ]);
  });
});

describe('providerCanaryKeys', () => {
  it('needs every secret of a provider', () => {
    expect(providerCanaryKeys('runway', { CANARY_RUNWAY_API_KEY: ' k ' })).toEqual(['k']);
    expect(providerCanaryKeys('runway', {})).toBeNull();
    expect(providerCanaryKeys('heygen', { CANARY_HEYGEN_API_KEY: 'k' })).toBeNull();
    expect(providerCanaryKeys('nope', {})).toBeNull();
  });

  it('builds an adapter for every provider it has secrets for', () => {
    for (const id of Object.keys(PROVIDER_CANARY_ENV)) {
      expect(buildCanaryAdapter(id, ['a', 'b'], fetch).providerId).toBe(id);
    }
    expect(() => buildCanaryAdapter('nope', ['a'], fetch)).toThrow('No provider canary');
  });
});

describe('runProviderCanary', () => {
  it('runs healthCheck through the recording fetch (Runway GET /v1/organization)', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(json({ creditBalance: 500 }, { deprecation: '@1767225600' }));
    const result = await runProviderCanary('runway', ['key'], base as unknown as typeof fetch);
    expect(result).toMatchObject({ providerId: 'runway', healthy: true, probed: true });
    expect(result.deprecations).toHaveLength(1);
    expect(String(base.mock.calls[0]?.[0])).toContain('/v1/organization');
  });

  it('reports an unhealthy provider with its reason', async () => {
    const base = vi.fn().mockResolvedValue(json({ error: 'bad key' }, {}, 401));
    const result = await runProviderCanary('runway', ['key'], base as unknown as typeof fetch);
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/auth|401|bad key/i);
  });

  it('marks Hive as not probed (its healthCheck sends no request)', async () => {
    const base = vi.fn();
    const result = await runProviderCanary('hive', ['key'], base as unknown as typeof fetch);
    expect(result.probed).toBe(false);
    expect(base).not.toHaveBeenCalled();
  });
});

describe('canaryAnnotations', () => {
  it('emits ::error for unhealthy, ::notice for not probed and ::warning per deprecation', () => {
    const lines = canaryAnnotations([
      { providerId: 'a', healthy: false, probed: true, reason: 'auth:\nbad', deprecations: [] },
      { providerId: 'h', healthy: true, probed: false, reason: 'not probed', deprecations: [] },
      {
        providerId: 'r',
        healthy: true,
        probed: true,
        reason: null,
        deprecations: [
          {
            providerId: 'r',
            method: 'GET',
            url: 'https://x/v1',
            status: 200,
            deprecation: '@1',
            sunset: null,
            link: null,
          },
        ],
      },
    ]);
    expect(lines).toEqual([
      '::error title=Provider canary a::auth: bad',
      '::notice title=Provider canary h::not probed (not probed)',
      '::warning title=Provider deprecation r::GET https://x/v1 → Deprecation: @1',
    ]);
  });
});
