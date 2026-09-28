import { describe, expect, it } from 'vitest';
import { loadScanSites, notTheRealSet, SCAN_MAX_SECONDS, SCAN_SET_SIZE } from './manifest';
import { runScanTiming, stagingClientFromEnv } from './scan-timing';

// BACKLOG 15.D10 / A14.2 "Website scan completes end-to-end in under 5 minutes for the 20 test
// sites in the QA fixture". Operator-run against STAGING through the public API — the real
// end-to-end path (queue, crawl, Claude, image library layers 1–2, embeddings):
//   POST /api/studio/businesses/:businessId/scan-website, then GET /api/studio/scans/:id until
//   SUCCEEDED / FAILED; duration = completedAt − startedAt from the scan row.
// Needs EVAL_STUDIO_BASE_URL + EVAL_STUDIO_TOKEN (a Core-issued JWT for the staging test org)
// and the 20-site fixture; otherwise the suite is skipped with the reason. At most 3 scans run
// at once (services/scans.ts MAX_ACTIVE_SCANS_PER_ORG) and 20 < the 25-per-day cap.

const sites = loadScanSites();
const client = stagingClientFromEnv();
const why =
  notTheRealSet(sites, SCAN_SET_SIZE) ??
  (client ? null : 'EVAL_STUDIO_BASE_URL / EVAL_STUDIO_TOKEN are not set');

describe.skipIf(why !== null)(
  `website scan timing (A14.2)${why ? ` (skipped: ${why})` : ''}`,
  () => {
    it(`every fixture site scans end-to-end in under ${SCAN_MAX_SECONDS / 60} minutes`, async () => {
      const results = await runScanTiming(client!, sites!.sites);
      const slow = results.filter((r) => r.state !== 'SUCCEEDED' || r.seconds >= SCAN_MAX_SECONDS);
      expect(slow, JSON.stringify(results, null, 1)).toEqual([]);
    });
  },
);
