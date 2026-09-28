import { z } from 'zod';
import type { ScanSites } from './manifest';

// BACKLOG 15.D10 — A14.2 scan timing against a staging deployment (scan-timing.eval.ts).
// Endpoints (this repo's own API): POST /api/studio/businesses/:id/scan-website
// { url, ownershipConfirmed: true } → 202 { scanId }; GET /api/studio/scans/:id → { scan }.

export const MAX_CONCURRENT_SCANS = 3;
const POLL_EVERY_MS = 5_000;
/** Give up on a scan well past the SLO so a stuck scan fails instead of hanging the run. */
const GIVE_UP_AFTER_MS = 15 * 60_000;

export interface StagingClient {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function stagingClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): StagingClient | null {
  const baseUrl = env.EVAL_STUDIO_BASE_URL?.trim();
  const token = env.EVAL_STUDIO_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    token,
    fetchImpl: fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}

const scanBody = z.object({
  scan: z.object({
    id: z.string(),
    state: z.string(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    errorReason: z.string().nullable().optional(),
  }),
});

export interface ScanTiming {
  id: string;
  url: string;
  state: string;
  seconds: number;
  error: string | null;
}

async function call(client: StagingClient, path: string, init?: RequestInit): Promise<unknown> {
  const res = await client.fetchImpl(`${client.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${client.token}`,
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new RangeError(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

/** Start one scan and wait for it to finish; seconds from the scan row's own timestamps. */
export async function timeScan(
  client: StagingClient,
  site: ScanSites['sites'][number],
): Promise<ScanTiming> {
  const started = z.object({ scanId: z.string() }).parse(
    await call(
      client,
      `/api/studio/businesses/${encodeURIComponent(site.businessId)}/scan-website`,
      {
        method: 'POST',
        body: JSON.stringify({ url: site.url, ownershipConfirmed: true }),
      },
    ),
  );
  const deadline = client.now() + GIVE_UP_AFTER_MS;
  for (;;) {
    const { scan } = scanBody.parse(
      await call(client, `/api/studio/scans/${encodeURIComponent(started.scanId)}`),
    );
    if (scan.state === 'SUCCEEDED' || scan.state === 'FAILED') {
      const end = Date.parse(scan.completedAt ?? new Date(client.now()).toISOString());
      return {
        id: site.id,
        url: site.url,
        state: scan.state,
        seconds: (end - Date.parse(scan.startedAt)) / 1000,
        error: scan.errorReason ?? null,
      };
    }
    if (client.now() > deadline) {
      return {
        id: site.id,
        url: site.url,
        state: `TIMED_OUT(${scan.state})`,
        seconds: GIVE_UP_AFTER_MS / 1000,
        error: 'gave up waiting',
      };
    }
    await client.sleep(POLL_EVERY_MS);
  }
}

/** All sites, at most MAX_CONCURRENT_SCANS at a time; a failed request counts as a failure. */
export async function runScanTiming(
  client: StagingClient,
  sites: ScanSites['sites'],
): Promise<ScanTiming[]> {
  const queue = [...sites];
  const results: ScanTiming[] = [];
  const worker = async () => {
    for (let site = queue.shift(); site; site = queue.shift()) {
      const current = site;
      results.push(
        await timeScan(client, current).catch((err: Error) => ({
          id: current.id,
          url: current.url,
          state: 'ERROR',
          seconds: Number.POSITIVE_INFINITY,
          error: err.message,
        })),
      );
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT_SCANS }, worker));
  return results;
}
