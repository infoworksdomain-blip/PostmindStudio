import { UpstreamServiceError } from '../../errors';
import { chunk, type CorpusState, type ManifestRow, type RowState } from './corpus-manifest';

// BACKLOG 9.2 / 9.3 — the network half of scripts/ops/ingest-corpus.ts, with fetch, sleep and
// the clock injected so batching, backoff and resume are unit tested. Talks only to Studio's
// admin API (POST /admin/library/ingest, GET /admin/library/ingest/status, GET
// /library/categories) with a staff token.

export interface StudioClient {
  categories(): Promise<Array<{ slug: string; children?: unknown }>>;
  ingest(items: IngestBody[]): Promise<HttpResult<IngestResult>>;
  status(query: Record<string, string>): Promise<IngestStatus>;
}

export interface HttpResult<T> {
  status: number;
  body: T | null;
  text: string;
  retryAfterSec?: number;
}

export interface IngestBody {
  sourceUrl: string;
  licenseScenario: 'NOT_REQUIRED' | 'LICENSED' | 'OWNED' | 'SCRAPED';
  licenseSource?: string;
  category?: string;
  tags: string[];
  title?: string;
  sourcePlatform?: string;
  sourceRef?: string;
  language?: string;
}

export interface IngestResult {
  queued: Array<{ sourceUrl: string; jobId: string; runId: string }>;
  skipped: Array<{
    sourceUrl: string;
    runId: string;
    state: string;
    libraryItemId: string | null;
  }>;
}

export interface RunStatus {
  runId: string;
  sourceRef: string | null;
  state: string;
  libraryItemId: string | null;
  errorReason: string | null;
}

export interface IngestStatus {
  counts: Record<string, number>;
  backlog: { queued: number; running: number };
  completedPerHour: number;
  liveLibraryItems: number;
  recentFailures: Array<{ runId: string; sourceUrl: string; errorReason: string | null }>;
  runs?: RunStatus[];
}

export function createStudioClient(input: {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}): StudioClient {
  const base = `${input.baseUrl.replace(/\/+$/, '')}/api/studio`;
  const headers = { authorization: `Bearer ${input.token}` };
  async function getJson<T>(path: string): Promise<T> {
    const res = await input.fetchImpl(`${base}${path}`, { headers });
    if (!res.ok)
      throw new UpstreamServiceError(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  return {
    async categories() {
      return (
        await getJson<{ data: Array<{ slug: string; children?: unknown }> }>('/library/categories')
      ).data;
    },
    async ingest(items) {
      const res = await input.fetchImpl(`${base}/admin/library/ingest`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ items }),
      });
      const text = await res.text();
      let body: IngestResult | null = null;
      try {
        body = res.ok ? (JSON.parse(text) as IngestResult) : null;
      } catch {
        body = null;
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        status: res.status,
        body,
        text,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSec: retryAfter }),
      };
    },
    status(query) {
      return getJson<IngestStatus>(
        `/admin/library/ingest/status?${new URLSearchParams(query).toString()}`,
      );
    },
  };
}

export const MAX_BACKOFF_MS = 60_000;

/** Exponential backoff with jitter; the server's Retry-After wins when present. */
export function backoffMs(
  attempt: number,
  retryAfterSec: number | undefined,
  random: () => number,
) {
  if (retryAfterSec) return Math.min(retryAfterSec * 1_000, 10 * MAX_BACKOFF_MS);
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt);
  return Math.round(base / 2 + (random() * base) / 2);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export function toIngestBody(
  row: ManifestRow,
  licence: { scenario: IngestBody['licenseScenario']; source?: string },
): IngestBody {
  return {
    sourceUrl: row.url,
    licenseScenario: licence.scenario,
    ...(licence.source && { licenseSource: licence.source }),
    tags: row.tags,
    ...(row.category && { category: row.category }),
    ...(row.title && { title: row.title }),
    ...(row.sourcePlatform && { sourcePlatform: row.sourcePlatform }),
    ...(row.sourceRef && { sourceRef: row.sourceRef }),
    ...(row.language && { language: row.language }),
  };
}

export interface SubmitOptions {
  client: StudioClient;
  licence: { scenario: IngestBody['licenseScenario']; source?: string };
  /** Batches in flight at once (HTTP concurrency, not the worker queue's). */
  concurrency: number;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => Date;
  sample?: boolean;
  /** Called after every batch with the updated state (persist it: that's what makes resume work). */
  onBatch: (state: CorpusState, done: number, total: number) => Promise<void>;
}

async function postWithRetry(
  opts: SubmitOptions,
  items: IngestBody[],
): Promise<HttpResult<IngestResult>> {
  for (let attempt = 0; ; attempt += 1) {
    let res: HttpResult<IngestResult>;
    try {
      res = await opts.client.ingest(items);
    } catch (err) {
      // Network error: retry like a 5xx.
      res = { status: 0, body: null, text: err instanceof Error ? err.message : String(err) };
    }
    const retryable = res.status === 0 || isRetryableStatus(res.status);
    if (!retryable || attempt >= opts.maxRetries) return res;
    await opts.sleep(backoffMs(attempt, res.retryAfterSec, opts.random));
  }
}

function batchStates(
  rows: ManifestRow[],
  res: HttpResult<IngestResult>,
  at: string,
  sample: boolean | undefined,
): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  const extra = sample ? { sample: true } : {};
  if (res.status !== 202 || !res.body) {
    const error = `HTTP ${res.status || 'network error'}: ${res.text.slice(0, 300)}`;
    for (const row of rows) out[row.url] = { status: 'rejected', error, at, ...extra };
    return out;
  }
  for (const q of res.body.queued)
    out[q.sourceUrl] = { status: 'accepted', runId: q.runId, jobId: q.jobId, at, ...extra };
  for (const s of res.body.skipped)
    out[s.sourceUrl] = {
      status: 'skipped',
      runId: s.runId,
      serverState: s.state,
      libraryItemId: s.libraryItemId,
      at,
      ...extra,
    };
  for (const row of rows)
    out[row.url] ??= { status: 'rejected', error: 'missing from the server response', at };
  return out;
}

/**
 * Submits rows in batches of ≤ 100, `concurrency` batches at a time, retrying 429/5xx/network
 * errors with backoff. A batch the server rejects (4xx) marks its rows `rejected` with the
 * reason; they are retried by the next run (pendingRows).
 */
export async function submitRows(
  rows: readonly ManifestRow[],
  initial: CorpusState,
  opts: SubmitOptions,
): Promise<CorpusState> {
  const batches = chunk(rows);
  let state = initial;
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, batches.length)) });
  await Promise.all(
    workers.map(async () => {
      while (next < batches.length) {
        const batch = batches[next] as ManifestRow[];
        next += 1;
        const res = await postWithRetry(
          opts,
          batch.map((row) => toIngestBody(row, opts.licence)),
        );
        state = {
          ...state,
          rows: {
            ...state.rows,
            ...batchStates(batch, res, opts.now().toISOString(), opts.sample),
          },
        };
        done += batch.length;
        await opts.onBatch(state, done, rows.length);
      }
    }),
  );
  return state;
}

const TERMINAL = new Set(['SUCCEEDED', 'DUPLICATE', 'FAILED']);

/** Per-run state for runIds (chunks of 100), polled until all are terminal or time runs out. */
export async function waitForRuns(
  client: StudioClient,
  runIds: readonly string[],
  opts: {
    pollMs: number;
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    onPoll?: (runs: RunStatus[]) => void;
  },
): Promise<{ runs: RunStatus[]; timedOut: boolean }> {
  const deadline = opts.now() + opts.timeoutMs;
  for (;;) {
    const runs: RunStatus[] = [];
    for (const ids of chunk(runIds)) {
      const res = await client.status({ runIds: ids.join(','), failures: '0', windowHours: '1' });
      runs.push(...(res.runs ?? []));
    }
    opts.onPoll?.(runs);
    const settled = runs.length >= runIds.length && runs.every((r) => TERMINAL.has(r.state));
    if (settled) return { runs, timedOut: false };
    if (opts.now() >= deadline) return { runs, timedOut: true };
    await opts.sleep(opts.pollMs);
  }
}
