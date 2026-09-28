import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  accuracy,
  classifierManifest,
  gradeClassification,
  loadClassifierManifest,
  loadScanSites,
  notTheRealSet,
  scanSites,
} from './manifest';
import { runScanTiming, stagingClientFromEnv, timeScan, type StagingClient } from './scan-timing';

// BACKLOG 15.D10 — manifest format, grading and the scan-timing client (offline).

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

describe('manifests', () => {
  it('the example fixtures parse and are marked illustrative (never the A14.2 set)', () => {
    const c = classifierManifest.parse(fixture('classifier-manifest.example.json'));
    const s = scanSites.parse(fixture('scan-sites.example.json'));
    expect(notTheRealSet(c, 50)).toBe('manifest is marked illustrative');
    expect(notTheRealSet(s, 20)).toBe('manifest is marked illustrative');
  });

  it('requires the full set and reports a missing one', () => {
    expect(notTheRealSet(null, 50)).toMatch(/H-03/);
    expect(notTheRealSet({ illustrative: false, sites: [1, 2] }, 50)).toMatch(/2 sites/);
    expect(notTheRealSet({ illustrative: false, sites: Array(50).fill(0) }, 50)).toBeNull();
  });

  it('loads from the env path and returns null when the file is absent', () => {
    const example = fileURLToPath(
      new URL('./fixtures/classifier-manifest.example.json', import.meta.url),
    );
    expect(loadClassifierManifest({ EVAL_CLASSIFIER_MANIFEST: example })?.illustrative).toBe(true);
    expect(loadClassifierManifest({ EVAL_CLASSIFIER_MANIFEST: `${example}.missing` })).toBeNull();
    expect(loadScanSites({ EVAL_SCAN_SITES: 'nope/none.json' })).toBeNull();
  });
});

describe('gradeClassification', () => {
  const label = { acceptIndustry: ['bakery', 'Baked goods'], rejectIndustry: ['equipment'] };
  it('matches accepted phrases case-insensitively in industry or sub-niche', () => {
    expect(gradeClassification(label, { industry: 'Food — BAKED GOODS', subNiche: 'x' })).toBe(
      true,
    );
    expect(gradeClassification(label, { industry: 'Food', subNiche: 'artisan bakery' })).toBe(true);
    expect(gradeClassification(label, { industry: 'Retail', subNiche: 'shoes' })).toBe(false);
  });
  it('rejected phrases win', () => {
    expect(gradeClassification(label, { industry: 'Bakery equipment', subNiche: '' })).toBe(false);
  });
  it('accuracy is the share correct', () => {
    expect(accuracy([])).toBe(0);
    expect(
      accuracy([
        { id: 'a', correct: true, detail: '' },
        { id: 'b', correct: false, detail: '' },
      ]),
    ).toBe(0.5);
  });
});

describe('scan timing client', () => {
  const T0 = Date.parse('2026-10-01T09:00:00Z');
  const site = { id: 's1', url: 'https://example.com/', businessId: 'biz_1' };

  function client(responses: Array<[number, unknown]>): StagingClient & { calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      const [status, body] = responses.shift() ?? [500, { error: 'no more' }];
      return new Response(JSON.stringify(body), { status });
    });
    return {
      baseUrl: 'https://staging.example',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => T0,
      calls,
    };
  }
  const scan = (state: string, completedAt: string | null) => ({
    scan: {
      id: 'scan_1',
      state,
      startedAt: '2026-10-01T09:00:00Z',
      completedAt,
      errorReason: null,
    },
  });

  it('starts the scan, polls until it finishes and times it from the scan row', async () => {
    const c = client([
      [202, { scanId: 'scan_1' }],
      [200, scan('RUNNING', null)],
      [200, scan('SUCCEEDED', '2026-10-01T09:03:20Z')],
    ]);
    expect(await timeScan(c, site)).toEqual({
      id: 's1',
      url: 'https://example.com/',
      state: 'SUCCEEDED',
      seconds: 200,
      error: null,
    });
    expect(c.calls).toEqual([
      'POST https://staging.example/api/studio/businesses/biz_1/scan-website',
      'GET https://staging.example/api/studio/scans/scan_1',
      'GET https://staging.example/api/studio/scans/scan_1',
    ]);
  });

  it('records a refused request as an ERROR result', async () => {
    const c = client([[429, { error: 'rate' }]]);
    const [result] = await runScanTiming(c, [site]);
    expect(result).toMatchObject({ state: 'ERROR', seconds: Number.POSITIVE_INFINITY });
  });

  it('needs a base URL and token', () => {
    expect(stagingClientFromEnv({})).toBeNull();
    expect(
      stagingClientFromEnv({ EVAL_STUDIO_BASE_URL: 'https://s/', EVAL_STUDIO_TOKEN: 'x' })?.baseUrl,
    ).toBe('https://s');
  });
});
