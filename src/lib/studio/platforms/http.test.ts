import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { asBody, classifyPlatformStatus, platformRequest, pollUntil } from './http';

describe('asBody', () => {
  it('returns the same view when it is already backed by an ArrayBuffer', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(asBody(bytes)).toBe(bytes);
  });

  it('copies bytes backed by a SharedArrayBuffer into a plain ArrayBuffer view', () => {
    const shared = new SharedArrayBuffer(3);
    const view = new Uint8Array(shared);
    view.set([1, 2, 3]);
    const result = asBody(view);
    expect(result).not.toBe(view);
    expect(Array.from(result)).toEqual([1, 2, 3]);
    expect(result.buffer instanceof ArrayBuffer).toBe(true);
  });
});

describe('classifyPlatformStatus', () => {
  it('maps known status codes to error classes', () => {
    expect(classifyPlatformStatus(401)).toEqual({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
    expect(classifyPlatformStatus(429)).toEqual({ errorClass: 'rate_limited', retryable: true });
    expect(classifyPlatformStatus(408)).toEqual({ errorClass: 'timeout', retryable: true });
    expect(classifyPlatformStatus(500)).toEqual({ errorClass: 'unavailable', retryable: true });
    expect(classifyPlatformStatus(503)).toEqual({ errorClass: 'unavailable', retryable: true });
  });

  it('maps any other 4xx to invalid_request, non-retryable', () => {
    expect(classifyPlatformStatus(400)).toEqual({
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(classifyPlatformStatus(404)).toEqual({
      errorClass: 'invalid_request',
      retryable: false,
    });
  });
});

describe('platformRequest', () => {
  it('parses a JSON body and returns status, headers and body on success', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ ok: true }, 200, { 'x-custom': '1' }));
    const res = await platformRequest<{ ok: boolean }>(
      'https://api.example.com/thing',
      {},
      { platform: 'tiktok', fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.get('x-custom')).toBe('1');
  });

  it('treats a non-JSON body as raw text', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await platformRequest<string>(
      'https://api.example.com',
      {},
      {
        platform: 'tiktok',
        fetchImpl,
      },
    );
    expect(res.body).toBe('plain text');
  });

  it('returns an empty body without throwing when the response text is empty', async () => {
    const { fetch: fetchImpl } = fakeFetch(new Response(null, { status: 204 }));
    const res = await platformRequest<undefined>(
      'https://api.example.com',
      {},
      {
        platform: 'tiktok',
        fetchImpl,
      },
    );
    expect(res.body).toBeUndefined();
    expect(res.status).toBe(204);
  });

  it('treats HTTP 308 as success (no PlatformError) despite !res.ok', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ redirected: true }, 308));
    const res = await platformRequest<{ redirected: boolean }>(
      'https://api.example.com',
      {},
      { platform: 'tiktok', fetchImpl },
    );
    expect(res.status).toBe(308);
    expect(res.body).toEqual({ redirected: true });
  });

  it('throws PlatformError using the default classification when no describe/refine given', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ msg: 'nope' }, 500));
    await expect(
      platformRequest('https://api.example.com', {}, { platform: 'tiktok', fetchImpl }),
    ).rejects.toMatchObject({ platform: 'tiktok', errorClass: 'unavailable', retryable: true });
  });

  it('uses describe() to extract a message and refine() to override the classification', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ error: 'boom', code: 'E1' }, 400));
    await expect(
      platformRequest(
        'https://api.example.com',
        {},
        {
          platform: 'tiktok',
          fetchImpl,
          describe: (body) => ({
            message: (body as { error?: string }).error,
            code: (body as { code?: string }).code,
          }),
          refine: (status, code) =>
            code === 'E1' ? { errorClass: 'content_policy', retryable: false } : undefined,
        },
      ),
    ).rejects.toMatchObject({
      message: 'boom',
      errorClass: 'content_policy',
      retryable: false,
      details: { status: 400, platformCode: 'E1' },
    });
  });

  it('falls back to "HTTP {status}" when describe returns no message', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({}, 400));
    await expect(
      platformRequest('https://api.example.com', {}, { platform: 'tiktok', fetchImpl }),
    ).rejects.toMatchObject({ message: 'HTTP 400' });
  });

  it('maps a fetch AbortError/TimeoutError to a retryable timeout PlatformError', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    const { fetch: fetchImpl } = fakeFetch(timeoutError);
    await expect(
      platformRequest('https://api.example.com', {}, { platform: 'tiktok', fetchImpl }),
    ).rejects.toMatchObject({ errorClass: 'timeout', retryable: true });
  });

  it('maps any other fetch failure to a retryable unavailable PlatformError', async () => {
    const { fetch: fetchImpl } = fakeFetch(new Error('network down'));
    await expect(
      platformRequest('https://api.example.com', {}, { platform: 'tiktok', fetchImpl }),
    ).rejects.toMatchObject({ errorClass: 'unavailable', retryable: true });
  });
});

describe('pollUntil', () => {
  it('returns as soon as check() yields a defined value', async () => {
    const check = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('done');
    const sleep = vi.fn(async () => undefined);
    const now = 0;
    const result = await pollUntil(check, {
      intervalMs: 1000,
      timeoutMs: 10_000,
      platform: 'tiktok',
      what: 'thing',
      sleep,
      now: () => now,
    });
    expect(result).toBe('done');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('throws a retryable timeout PlatformError once the deadline passes', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    let now = 0;
    const sleep = vi.fn(async () => {
      now += 10_000;
    });
    await expect(
      pollUntil(check, {
        intervalMs: 10_000,
        timeoutMs: 15_000,
        platform: 'tiktok',
        what: 'the thing',
        sleep,
        now: () => now,
      }),
    ).rejects.toMatchObject({ errorClass: 'timeout', retryable: true, platform: 'tiktok' });
  });

  it('propagates an error thrown by check()', async () => {
    const boom = new PlatformError('tiktok', 'invalid_media', 'bad', false);
    const check = vi.fn().mockRejectedValue(boom);
    await expect(
      pollUntil(check, {
        intervalMs: 100,
        timeoutMs: 1000,
        platform: 'tiktok',
        what: 'thing',
        sleep: vi.fn(async () => undefined),
        now: () => 0,
      }),
    ).rejects.toBe(boom);
  });
});
