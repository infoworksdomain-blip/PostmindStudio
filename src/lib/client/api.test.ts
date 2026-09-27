import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiPath, ApiError, errorMessage, newIdempotencyKey } from './api';

describe('apiPath', () => {
  it('prefixes a bare path with /api/studio/', () => {
    expect(apiPath('projects')).toBe('/api/studio/projects');
  });

  it('prefixes a leading-slash path with /api/studio', () => {
    expect(apiPath('/projects')).toBe('/api/studio/projects');
  });

  it('leaves a path already under /api/ untouched', () => {
    expect(apiPath('/api/metrics')).toBe('/api/metrics');
  });

  it('appends a query string from provided params', () => {
    expect(apiPath('projects', { state: 'DRAFT', limit: 10 })).toBe(
      '/api/studio/projects?state=DRAFT&limit=10',
    );
  });

  it('omits undefined, null and empty-string query values', () => {
    expect(apiPath('projects', { state: undefined, cursor: null, q: '', limit: 5 })).toBe(
      '/api/studio/projects?limit=5',
    );
  });

  it('coerces boolean and number query values to strings', () => {
    expect(apiPath('projects', { active: true, limit: 0 })).toBe(
      '/api/studio/projects?active=true&limit=0',
    );
  });

  it('returns the bare path with no query string when there are no params', () => {
    expect(apiPath('projects', {})).toBe('/api/studio/projects');
  });
});

type FetchArgs = [url: string, init: RequestInit];

function mockFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a GET by default and returns the parsed JSON body', async () => {
    const fetchMock = mockFetch(async () => Response.json({ ok: true, data: [1, 2] }));

    const result = await api<{ ok: boolean; data: number[] }>('projects');
    expect(result).toEqual({ ok: true, data: [1, 2] });
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/studio/projects');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
  });

  it('defaults to POST when a body is given, and JSON-encodes it', async () => {
    const fetchMock = mockFetch(async () => Response.json({ ok: true }));

    await api('projects', { body: { name: 'Test' } });
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Test' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('sends FormData bodies as-is without a content-type override', async () => {
    const fetchMock = mockFetch(async () => Response.json({ ok: true }));

    const form = new FormData();
    form.set('file', 'x');
    await api('uploads', { body: form });
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('sends an Idempotency-Key header when provided', async () => {
    const fetchMock = mockFetch(async () => Response.json({ ok: true }));

    await api('projects', { body: {}, idempotencyKey: 'abc-123' });
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('abc-123');
  });

  it('passes query params and an explicit method through', async () => {
    const fetchMock = mockFetch(async () => Response.json({ ok: true }));

    await api('projects/1', { method: 'DELETE', query: { hard: true } });
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/studio/projects/1?hard=true');
    expect(init.method).toBe('DELETE');
  });

  it('throws an ApiError built from the error envelope on a non-2xx response', async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: 'validation_error',
            message: 'Bad input',
            details: { field: 'name' },
          }),
          { status: 400 },
        ),
    );

    const err: unknown = await api('projects', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe('validation_error');
    expect(apiErr.message).toBe('Bad input');
    expect(apiErr.details).toEqual({ field: 'name' });
  });

  it('falls back to generic error fields when the response body is not JSON', async () => {
    mockFetch(async () => new Response('<html>502</html>', { status: 502 }));

    const err: unknown = await api('projects').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(502);
    expect(apiErr.code).toBe('http_502');
    expect(apiErr.message).toBe('Request failed (502)');
  });

  it('returns undefined for a 2xx response with an empty body', async () => {
    mockFetch(async () => new Response(null, { status: 204 }));

    await expect(api('projects/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('newIdempotencyKey', () => {
  it('generates a non-empty string', () => {
    expect(newIdempotencyKey().length).toBeGreaterThan(0);
  });

  it('generates distinct keys across calls', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe('errorMessage', () => {
  it('maps 401 to a session-expired message', () => {
    expect(errorMessage(new ApiError(401, 'unauthorized', 'nope'))).toBe(
      'Your PostMind session has expired. Sign in again.',
    );
  });

  it('maps 403 to a permission message', () => {
    expect(errorMessage(new ApiError(403, 'forbidden', 'nope'))).toContain('permission');
  });

  it('maps 429 to a rate-limit message', () => {
    expect(errorMessage(new ApiError(429, 'rate_limited', 'nope'))).toContain('Too many requests');
  });

  it('appends validation problems from details when present', () => {
    const err = new ApiError(400, 'validation_error', 'Request body failed validation', {
      problems: ['name is required', 'colours must be #RRGGBB'],
    });
    expect(errorMessage(err)).toBe(
      'Request body failed validation: name is required; colours must be #RRGGBB',
    );
  });

  it('falls back to the raw message for other statuses without problems', () => {
    expect(errorMessage(new ApiError(500, 'internal_error', 'Something broke'))).toBe(
      'Something broke',
    );
  });

  it('handles a plain Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('handles a non-Error thrown value', () => {
    expect(errorMessage('a string was thrown')).toBe('Something went wrong.');
  });
});
