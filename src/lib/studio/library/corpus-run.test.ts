import { describe, expect, it } from 'vitest';
import { emptyState, pendingRows, type ManifestRow } from './corpus-manifest';
import {
  backoffMs,
  createStudioClient,
  isRetryableStatus,
  MAX_BACKOFF_MS,
  submitRows,
  toIngestBody,
  waitForRuns,
  type HttpResult,
  type IngestBody,
  type IngestResult,
  type RunStatus,
  type StudioClient,
} from './corpus-run';

const rows = (n: number): ManifestRow[] =>
  Array.from({ length: n }, (_, i) => ({
    line: i + 2,
    url: `https://cdn.example/${i}.mp4`,
    tags: ['t'],
    ...(i % 2 === 0 && { category: 'lifestyle', sourceRef: `ref-${i}`, language: 'en' }),
  }));

const accept = (items: IngestBody[]): HttpResult<IngestResult> => ({
  status: 202,
  text: '',
  body: {
    queued: items.map((i) => ({
      sourceUrl: i.sourceUrl,
      runId: `run-${i.sourceUrl}`,
      jobId: `job-${i.sourceUrl}`,
    })),
    skipped: [],
  },
});

function fakeClient(respond: (items: IngestBody[], call: number) => HttpResult<IngestResult>) {
  const calls: IngestBody[][] = [];
  const client: StudioClient = {
    categories: async () => [],
    ingest: async (items) => {
      calls.push(items);
      return respond(items, calls.length);
    },
    status: async () => ({
      counts: {},
      backlog: { queued: 0, running: 0 },
      completedPerHour: 0,
      liveLibraryItems: 0,
      recentFailures: [],
    }),
  };
  return { client, calls };
}

function options(client: StudioClient, overrides: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  const saved: number[] = [];
  return {
    sleeps,
    saved,
    opts: {
      client,
      licence: { scenario: 'NOT_REQUIRED' as const, source: 'Operator decision 2026-09-27' },
      concurrency: 2,
      maxRetries: 3,
      sleep: async (ms: number) => void sleeps.push(ms),
      random: () => 0.5,
      now: () => new Date('2026-09-27T12:00:00Z'),
      onBatch: async (_s: unknown, done: number) => void saved.push(done),
      ...overrides,
    },
  };
}

describe('backoff', () => {
  it('grows exponentially with jitter, is capped, and honours Retry-After', () => {
    expect(backoffMs(0, undefined, () => 0)).toBe(500);
    expect(backoffMs(3, undefined, () => 1)).toBe(8_000);
    expect(backoffMs(20, undefined, () => 1)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(0, 7, () => 0)).toBe(7_000);
  });

  it('retries only 408, 429 and 5xx', () => {
    expect([400, 401, 403, 408, 409, 429, 500, 503].map(isRetryableStatus)).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe('toIngestBody', () => {
  it('sends the NOT_REQUIRED licence with its audit source and only present fields', () => {
    const [withAll, bare] = rows(2);
    expect(
      toIngestBody(withAll as ManifestRow, { scenario: 'NOT_REQUIRED', source: 'op' }),
    ).toEqual({
      sourceUrl: 'https://cdn.example/0.mp4',
      licenseScenario: 'NOT_REQUIRED',
      licenseSource: 'op',
      tags: ['t'],
      category: 'lifestyle',
      sourceRef: 'ref-0',
      language: 'en',
    });
    expect(toIngestBody(bare as ManifestRow, { scenario: 'NOT_REQUIRED' })).toEqual({
      sourceUrl: 'https://cdn.example/1.mp4',
      licenseScenario: 'NOT_REQUIRED',
      tags: ['t'],
    });
  });
});

describe('submitRows', () => {
  it('submits in batches of at most 100 and records accepted rows with run and job ids', async () => {
    const { client, calls } = fakeClient(accept);
    const { opts, saved } = options(client);
    const state = await submitRows(rows(250), emptyState('m.csv'), opts);
    expect(calls.map((c) => c.length).sort()).toEqual([100, 100, 50]);
    expect(saved.at(-1)).toBe(250);
    expect(Object.values(state.rows).every((r) => r.status === 'accepted')).toBe(true);
    expect(state.rows['https://cdn.example/0.mp4']).toMatchObject({
      runId: 'run-https://cdn.example/0.mp4',
      jobId: 'job-https://cdn.example/0.mp4',
      at: '2026-09-27T12:00:00.000Z',
    });
  });

  it('retries 429 (Retry-After) and 5xx with backoff, then succeeds', async () => {
    const { client, calls } = fakeClient((items, call) =>
      call === 1
        ? { status: 429, body: null, text: 'slow down', retryAfterSec: 30 }
        : call === 2
          ? { status: 503, body: null, text: 'unavailable' }
          : accept(items),
    );
    const { opts, sleeps } = options(client, { concurrency: 1 });
    const state = await submitRows(rows(3), emptyState('m.csv'), opts);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([30_000, 1_500]);
    expect(Object.values(state.rows).map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
  });

  it('marks a batch rejected on 4xx or exhausted retries, and a re-run resumes only those', async () => {
    let failing = true;
    const { client, calls } = fakeClient((items) =>
      failing && items.some((i) => i.sourceUrl.endsWith('/0.mp4'))
        ? { status: 400, body: null, text: '{"error":"bad category"}' }
        : accept(items),
    );
    const all = rows(150);
    const { opts } = options(client, { concurrency: 1 });
    const first = await submitRows(all, emptyState('m.csv'), opts);
    expect(first.rows['https://cdn.example/0.mp4']).toMatchObject({
      status: 'rejected',
      error: 'HTTP 400: {"error":"bad category"}',
    });
    expect(first.rows['https://cdn.example/120.mp4']?.status).toBe('accepted');
    const pending = pendingRows(all, first);
    expect(pending).toHaveLength(100);

    failing = false;
    const second = await submitRows(pending, first, opts);
    expect(calls.at(-1)).toHaveLength(100);
    expect(pendingRows(all, second)).toEqual([]);

    const down = fakeClient(() => ({ status: 502, body: null, text: 'bad gateway' }));
    const { opts: downOpts, sleeps } = options(down.client, { maxRetries: 2 });
    const third = await submitRows(rows(1), emptyState('m.csv'), downOpts);
    expect(down.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(third.rows['https://cdn.example/0.mp4']?.status).toBe('rejected');
  });

  it('treats network errors as retryable and keeps rows the server skipped', async () => {
    let call = 0;
    const client: StudioClient = {
      ...fakeClient(accept).client,
      ingest: async (items) => {
        call += 1;
        if (call === 1) throw new TypeError('fetch failed');
        return {
          status: 202,
          text: '',
          body: {
            queued: [],
            skipped: items.map((i) => ({
              sourceUrl: i.sourceUrl,
              runId: 'r',
              state: 'SUCCEEDED',
              libraryItemId: 'lib_1',
            })),
          },
        };
      },
    };
    const { opts } = options(client, { sample: true });
    const state = await submitRows(rows(1), emptyState('m.csv'), opts);
    expect(state.rows['https://cdn.example/0.mp4']).toMatchObject({
      status: 'skipped',
      serverState: 'SUCCEEDED',
      libraryItemId: 'lib_1',
      sample: true,
    });
  });
});

describe('createStudioClient', () => {
  it('posts batches with the staff token and parses Retry-After', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/ingest'))
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '12' } });
      if (url.includes('/status?'))
        return Response.json({ counts: {}, runs: [{ runId: 'a', state: 'QUEUED' }] });
      return Response.json({ ok: true, data: [{ slug: 'x', children: [] }] });
    }) as typeof fetch;
    const client = createStudioClient({ baseUrl: 'https://studio.test/', token: 'tok', fetchImpl });
    const res = await client.ingest([
      { sourceUrl: 'https://a/1.mp4', licenseScenario: 'NOT_REQUIRED', tags: [] },
    ]);
    expect(res).toEqual({ status: 429, body: null, text: 'rate limited', retryAfterSec: 12 });
    expect(seen[0]?.url).toBe('https://studio.test/api/studio/admin/library/ingest');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await client.categories()).toEqual([{ slug: 'x', children: [] }]);
    const status = await client.status({ runIds: 'a,b' });
    expect(status.runs).toEqual([{ runId: 'a', state: 'QUEUED' }]);
    expect(seen.at(-1)?.url).toBe(
      'https://studio.test/api/studio/admin/library/ingest/status?runIds=a%2Cb',
    );
  });

  it('throws an upstream error when a GET fails', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    const client = createStudioClient({ baseUrl: 'https://studio.test', token: 't', fetchImpl });
    await expect(client.categories()).rejects.toThrow('GET /library/categories failed: 403');
  });
});

describe('waitForRuns', () => {
  it('polls in chunks of 100 until every run is terminal', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `r${i}`);
    let poll = 0;
    const queries: string[] = [];
    const client: StudioClient = {
      ...fakeClient(accept).client,
      status: async (q) => {
        queries.push(q.runIds ?? '');
        const list = (q.runIds ?? '').split(',');
        const state = poll >= 2 ? 'SUCCEEDED' : 'RUNNING';
        return {
          counts: {},
          backlog: { queued: 0, running: 0 },
          completedPerHour: 0,
          liveLibraryItems: 0,
          recentFailures: [],
          runs: list.map((runId): RunStatus => ({
            runId,
            state,
            sourceRef: null,
            libraryItemId: null,
            errorReason: null,
          })),
        };
      },
    };
    let now = 0;
    const result = await waitForRuns(client, ids, {
      pollMs: 1_000,
      timeoutMs: 60_000,
      sleep: async (ms) => {
        poll += 1;
        now += ms;
      },
      now: () => now,
    });
    expect(result.timedOut).toBe(false);
    expect(result.runs).toHaveLength(150);
    expect(queries).toHaveLength(6);
    expect(queries[0]?.split(',')).toHaveLength(100);
  });

  it('gives up at the deadline', async () => {
    let now = 0;
    const client: StudioClient = {
      ...fakeClient(accept).client,
      status: async () => ({
        counts: {},
        backlog: { queued: 1, running: 0 },
        completedPerHour: 0,
        liveLibraryItems: 0,
        recentFailures: [],
        runs: [
          { runId: 'a', state: 'QUEUED', sourceRef: null, libraryItemId: null, errorReason: null },
        ],
      }),
    };
    const result = await waitForRuns(client, ['a'], {
      pollMs: 10_000,
      timeoutMs: 25_000,
      sleep: async (ms) => void (now += ms),
      now: () => now,
    });
    expect(result.timedOut).toBe(true);
  });
});
