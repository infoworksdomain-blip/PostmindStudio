// PostMind Studio — HTTP load test (BACKLOG 12.1; Engagement handover 16.4 pattern).
// Plain k6 JavaScript (k6 runs its own JS runtime; this file is not part of the Next.js build).
//
// Smoke (~5 VUs, 50s):
//   k6 run --env RUN_MODE=smoke --env BASE_URL=https://studio-staging.postmind.ai \
//     --env STUDIO_TOKEN=$STAGING_POSTMIND_JWT --env BUSINESS_ID=$LOADTEST_BUSINESS_ID \
//     load-test/k6/studio-api.js
// Full profile (~4 min: ramp / steady / 3x spike / recover / ramp-down): RUN_MODE=full.
//
// STUDIO_TOKEN is a staging PostMind Core JWT for a dedicated load-test organisation (never a
// production customer). Writes are OFF unless WRITES=1; with writes on, the test creates DRAFT
// projects only — it never calls /generate, so no provider spend is incurred.
//
// Pass thresholds (spec 17.1: non-generation API p95 < 300ms; Engagement: error rate < 0.1%).

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const MODE = __ENV.RUN_MODE || 'smoke';
const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3010').replace(/\/$/, '');
const TOKEN = __ENV.STUDIO_TOKEN || '';
const BUSINESS_ID = __ENV.BUSINESS_ID || '';
const WRITES = __ENV.WRITES === '1';
const TARGET_VUS = Number(__ENV.TARGET_VUS || 50);

const errors = new Rate('studio_errors');
const readLatency = new Trend('studio_read_latency', true);
const writeLatency = new Trend('studio_write_latency', true);

const PROFILES = {
  smoke: { vus: 5, duration: '50s' },
  full: {
    stages: [
      { duration: '30s', target: TARGET_VUS }, // ramp
      { duration: '90s', target: TARGET_VUS }, // steady
      { duration: '20s', target: TARGET_VUS * 3 }, // 3x spike
      { duration: '60s', target: TARGET_VUS }, // recover
      { duration: '30s', target: 0 }, // ramp-down
    ],
  },
};

export const options = {
  ...(PROFILES[MODE] || PROFILES.smoke),
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<2000'],
    studio_read_latency: ['p(95)<300'],
    studio_write_latency: ['p(95)<500'],
    studio_errors: ['rate<0.001'],
    // Rate limiting is expected under the spike; anything else non-2xx counts as an error.
    checks: ['rate>0.999'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (!TOKEN) throw new Error('STUDIO_TOKEN is required (staging PostMind JWT)');
  const ready = http.get(`${BASE_URL}/api/health/ready`);
  if (ready.status !== 200) throw new Error(`Target not ready: ${ready.status} ${ready.body}`);
  if (WRITES && !BUSINESS_ID) throw new Error('WRITES=1 needs BUSINESS_ID');
}

function headers(extra) {
  return { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json', ...extra } };
}

function read(name, path) {
  const res = http.get(`${BASE_URL}/api/studio${path}`, { ...headers(), tags: { name } });
  readLatency.add(res.timings.duration);
  const ok = check(res, { [`${name} 200`]: (r) => r.status === 200 || r.status === 429 });
  errors.add(!ok);
  return res;
}

function uuid() {
  // RFC 4122 v4 shape; k6 has no crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function studioApiScenario() {
  group('liveness', () => {
    const res = http.get(`${BASE_URL}/api/health`, { tags: { name: 'health' } });
    errors.add(!check(res, { 'health 200': (r) => r.status === 200 }));
  });

  group('manage', () => {
    const list = read('projects.list', `/projects?limit=20`);
    read('publications.list', `/publications?limit=20`);
    const first = list.status === 200 ? list.json('data.0.id') : undefined;
    if (first) read('projects.get', `/projects/${first}`);
  });

  group('analytics', () => {
    read('analytics.overview', `/analytics/overview`);
    read('analytics.timeseries', `/analytics/timeseries?days=30&metric=views`);
  });

  group('library', () => {
    read('library.videos', `/library/videos?limit=24`);
  });

  if (WRITES && Math.random() < 0.1) {
    group('create draft', () => {
      const body = JSON.stringify({
        name: `k6 load test ${uuid().slice(0, 8)}`,
        businessId: BUSINESS_ID,
        brief: { rawInput: 'Load test draft — never generated.' },
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      });
      const res = http.post(
        `${BASE_URL}/api/studio/projects`,
        body,
        headers({ 'content-type': 'application/json', 'idempotency-key': uuid() }),
      );
      writeLatency.add(res.timings.duration);
      errors.add(
        !check(res, { 'project create 201': (r) => r.status === 201 || r.status === 429 }),
      );
    });
  }

  sleep(1);
}
