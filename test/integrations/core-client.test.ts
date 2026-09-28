import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  backoffMs,
  isRetryableStatus,
  MAX_REFRESH_BATCH as CLIENT_MAX_BATCH,
  parseRetryAfter,
  StudioInternalClient,
  StudioInternalError,
  type AccountRef,
  type PurgeResult,
  type RefreshedTokenInput,
  type RefreshResult,
  type RegisterChannelInput,
  type StudioChannel,
} from '../../integrations/core/client/studio-internal-client';
import type {
  publicChannelSchema,
  purgeResultSchema,
  refreshResultSchema,
} from '../../src/lib/studio/api/internal-contract';
import {
  MAX_REFRESH_BATCH,
  type accountRefInput,
  type refreshedTokenInput,
  type registerMetaChannelInput,
} from '../../src/lib/studio/services/meta-channels';

// BACKLOG 14.10 — the copyable Core client (integrations/core/client): its types must equal the
// route handlers' zod schemas (compile-time checks below fail `npm run typecheck` on drift), and
// its retry behaviour: backoff with jitter on 429 / 5xx / network errors, Retry-After honoured,
// no retry on other 4xx, one correlation id per logical call, batches chunked at 100.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const typesMatch: [
  Equal<RegisterChannelInput, z.input<typeof registerMetaChannelInput>>,
  Equal<RefreshedTokenInput, z.input<typeof refreshedTokenInput>>,
  Equal<AccountRef, z.input<typeof accountRefInput>>,
  Equal<StudioChannel, z.output<typeof publicChannelSchema>>,
  Equal<RefreshResult, z.output<typeof refreshResultSchema>>,
  Equal<PurgeResult, z.output<typeof purgeResultSchema>>,
] = [true, true, true, true, true, true];

const BASE = 'http://studio.test';
const TOKEN = 't'.repeat(40);

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(responses: Array<Response | Error>, extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const onRetry = vi.fn();
  const c = new StudioInternalClient({
    baseUrl: `${BASE}/`,
    serviceToken: TOKEN,
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onRetry,
    ...extra,
  });
  return { c, calls, sleeps, onRetry };
}

const channel = {
  id: 'ch1',
  organisationId: 'org',
  businessId: null,
  platform: 'instagram',
  platformAccountId: '1',
  platformAccountName: '@a',
  accessTokenExpiresAt: null,
  scopes: [],
  state: 'active',
  connectedAt: '2026-10-01T00:00:00.000Z',
};
const register: RegisterChannelInput = {
  organisationId: 'org',
  platform: 'instagram',
  platformAccountId: '1',
  platformAccountName: '@a',
  accessToken: 'EAAG-secret-token-value',
};

describe('client types', () => {
  it('match the route handlers’ zod schemas (checked at compile time)', () => {
    expect(typesMatch.every(Boolean)).toBe(true);
    expect(CLIENT_MAX_BATCH).toBe(MAX_REFRESH_BATCH);
  });
});

describe('retry helpers', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(parseRetryAfter('7', now)).toBe(7000);
    expect(parseRetryAfter('Thu, 01 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('backs off exponentially with full jitter under a cap', () => {
    expect(backoffMs(1, 500, 30_000, () => 0.999)).toBe(499);
    expect(backoffMs(4, 500, 30_000, () => 1)).toBe(4000);
    expect(backoffMs(20, 500, 30_000, () => 1)).toBe(30_000);
    expect(backoffMs(3, 500, 30_000, () => 0)).toBe(0);
  });

  it('retries 408/425/429/5xx only', () => {
    expect([408, 425, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 409, 413, 422, 501].some(isRetryableStatus)).toBe(false);
  });
});

describe('StudioInternalClient', () => {
  it('sends the service token, JSON and a correlation id; strips ok from the result', async () => {
    const { c, calls } = client([json(201, { ok: true, channel, created: true })]);
    const res = await c.registerChannel(register);
    expect(res).toEqual({ channel, created: true });
    const [call] = calls;
    expect(call?.url).toBe(`${BASE}/api/studio/internal/channels`);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-service-token']).toBe(TOKEN);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-correlation-id']).toMatch(/^core-[0-9a-f]{24}$/);
    expect(JSON.parse(String(call?.init.body))).toEqual(register);
  });

  it('honours Retry-After on 429, backs off on 503 and network errors, same correlation id', async () => {
    const { c, calls, sleeps, onRetry } = client([
      json(429, { ok: false, error: 'rate_limited' }, { 'retry-after': '3' }),
      json(503, { ok: false, error: 'kill_switch_active' }),
      new TypeError('fetch failed'),
      json(202, { ok: true, purge: { organisationId: 'org' } }),
    ]);
    const res = await c.purgeOrganisation('org/1');
    expect(res.purge.organisationId).toBe('org');
    expect(calls[0]?.url).toBe(`${BASE}/api/studio/internal/organisations/org%2F1/purge`);
    expect(sleeps).toEqual([3000, 500, 1000]);
    const ids = new Set(
      calls.map((x) => (x.init.headers as Record<string, string>)['x-correlation-id']),
    );
    expect(ids.size).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, status: 429, delayMs: 3000 });
    expect(onRetry.mock.calls[2]?.[0]).toMatchObject({ error: 'TypeError: fetch failed' });
  });

  it('clamps a long Retry-After', async () => {
    const { c, sleeps } = client(
      [json(429, { ok: false }, { 'retry-after': '3600' }), json(200, { ok: true, result: {} })],
      { maxRetryAfterMs: 5000 },
    );
    await c.pushRefreshedToken({ ...register });
    expect(sleeps).toEqual([5000]);
  });

  it('does not retry other 4xx and never puts the token in the error', async () => {
    const { c, calls } = client([
      json(409, { ok: false, error: 'conflict', message: 'Channel was disconnected' }),
    ]);
    const err = await c.pushRefreshedToken(register).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioInternalError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', attempts: 1, retryable: false });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain('secret-token');
  });

  it('gives up after maxAttempts with the last status', async () => {
    const { c, calls } = client(
      [json(500, { ok: false, error: 'internal_error' }), json(502, 'bad gateway')],
      { maxAttempts: 2 },
    );
    const err = (await c.disconnectChannel('ch1').catch((e: unknown) => e)) as StudioInternalError;
    expect(err).toMatchObject({ status: 502, code: 'http_502', attempts: 2, retryable: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.method).toBe('DELETE');
  });

  it('builds the disconnect query strings', async () => {
    const { c, calls } = client([
      json(200, { ok: true, disconnected: true, channel }),
      json(200, { ok: true, disconnected: true, channel }),
    ]);
    await c.disconnectChannel('ch1', { organisationId: 'org 1' });
    await c.disconnectChannelByAccount({
      organisationId: 'o',
      platform: 'facebook',
      platformAccountId: '9',
    });
    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/api/studio/internal/channels/ch1?organisationId=org+1`,
      `${BASE}/api/studio/internal/channels?organisationId=o&platform=facebook&platformAccountId=9`,
    ]);
  });

  it('chunks refreshed tokens into batches of 100 and concatenates results', async () => {
    const items = Array.from({ length: 150 }, (_, i) => ({
      ...register,
      platformAccountId: `${i}`,
    }));
    const result = (n: number) => ({ ...register, result: 'updated', platformAccountId: `${n}` });
    const { c, calls } = client([
      json(200, { ok: true, results: items.slice(0, 100).map((_, i) => result(i)) }),
      json(200, { ok: true, results: items.slice(100).map((_, i) => result(100 + i)) }),
    ]);
    const results = await c.pushRefreshedTokens(items);
    expect(results).toHaveLength(150);
    expect(
      calls.map(
        (x) => (JSON.parse(String(x.init.body)) as { channels: unknown[] }).channels.length,
      ),
    ).toEqual([100, 50]);
  });

  it('times out a hung attempt and retries it', async () => {
    let n = 0;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          n += 1;
          if (n === 1) {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            return;
          }
          resolve(json(200, { ok: true, result: {} }));
        }),
    );
    const c = new StudioInternalClient({
      baseUrl: BASE,
      serviceToken: TOKEN,
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
      sleep: async () => undefined,
    });
    await expect(c.pushRefreshedToken(register)).resolves.toEqual({ result: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requires a base URL and a token', () => {
    expect(() => new StudioInternalClient({ baseUrl: '', serviceToken: TOKEN })).toThrow(TypeError);
    expect(() => new StudioInternalClient({ baseUrl: BASE, serviceToken: '' })).toThrow(TypeError);
  });
});
