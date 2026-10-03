// PostMind Studio — 200 concurrent users (BACKLOG 20.29, operator target 2026-10-03).
// Plain k6 JavaScript. Run ONLY against a disposable stack (the load-test workflow's copy of
// deploy/vps/compose.yml): it signs in seeded users, creates projects and presses "generate";
// the stack's worker runs with simulated providers, so no paid API is called.
//
//   k6 run --env BASE_URL=http://web:3010 --env ORIGIN=https://studio.ci.invalid \
//     --env ACCOUNTS=/results/accounts.json --summary-export /results/k6-summary.json \
//     load-test/k6/studio-users.js
//
// Scenarios:
//   users     ramping-vus 0 → USERS (default 200) over 2 min, hold HOLD (default 6 min), ramp down;
//             each VU is one person: mixed reads (dashboard, project, library, calendar,
//             analytics, page loads) and writes (create a project, sometimes generate it), with
//             3–8 s of think time between actions.
//   generate  BURST users (default 100) press "generate" in the same second, 3 minutes in.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const ORIGIN = (__ENV.ORIGIN || BASE_URL).replace(/\/$/, '');
const USERS = Number(__ENV.USERS || 200);
const BURST = Number(__ENV.BURST || 100);
const HOLD = __ENV.HOLD || '6m';
const ACCOUNTS = JSON.parse(open(__ENV.ACCOUNTS || './accounts.json'));

const errors = new Rate('studio_errors');
const readLatency = new Trend('studio_read_latency', true);
const writeLatency = new Trend('studio_write_latency', true);
const pageLatency = new Trend('studio_page_latency', true);
const generateLatency = new Trend('studio_generate_latency', true);
const rateLimited = new Counter('studio_rate_limited');
const quotaRefused = new Counter('studio_quota_refused');
const generated = new Counter('studio_generate_accepted');

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      exec: 'user',
      stages: [
        { duration: '2m', target: USERS },
        { duration: HOLD, target: USERS },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    generate: {
      executor: 'per-vu-iterations',
      exec: 'pressGenerate',
      vus: BURST,
      iterations: 1,
      startTime: '3m',
      maxDuration: '2m',
    },
  },
  thresholds: {
    // Spec 17.1: non-generation API p95 < 300 ms; pages are server-rendered, so a looser bar.
    studio_read_latency: ['p(95)<300'],
    studio_write_latency: ['p(95)<800'],
    studio_page_latency: ['p(95)<1500'],
    studio_generate_latency: ['p(95)<1500'],
    studio_errors: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function account() {
  return ACCOUNTS[(exec.vu.idInTest - 1) % ACCOUNTS.length];
}

function params(a, name, extra) {
  return {
    headers: {
      cookie: a.cookie,
      origin: ORIGIN,
      accept: 'application/json',
      'x-studio-organisation-id': a.organisationId,
      ...extra,
    },
    tags: { name },
  };
}

function ok(res, name, trend, allowed) {
  trend.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  const good = check(res, {
    [`${name} ok`]: (r) =>
      (r.status >= 200 && r.status < 300) || (allowed || []).includes(r.status),
  });
  errors.add(!good);
  return good;
}

function get(a, name, path) {
  const res = http.get(`${BASE_URL}/api/studio${path}`, params(a, name));
  ok(res, name, readLatency, [429]);
  return res;
}

function page(a, name, path) {
  const res = http.get(`${BASE_URL}${path}`, {
    ...params(a, name),
    headers: { ...params(a, name).headers, accept: 'text/html' },
  });
  ok(res, name, pageLatency, [429]);
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function createProject(a) {
  const body = JSON.stringify({
    name: `k6 ${uuid().slice(0, 8)}`,
    businessId: a.businessId,
    brief: {
      rawInput:
        'A 30-second TikTok announcing our weekly sourdough subscription. Warm tone. Call to action: subscribe on our website.',
    },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
  });
  const res = http.post(
    `${BASE_URL}/api/studio/projects`,
    body,
    params(a, 'projects.create', { 'content-type': 'application/json', 'idempotency-key': uuid() }),
  );
  ok(res, 'projects.create', writeLatency, [429]);
  return res.status === 201 ? res.json('project.id') : undefined;
}

function generate(a, projectId) {
  const res = http.post(
    `${BASE_URL}/api/studio/projects/${projectId}/generate`,
    '{}',
    params(a, 'projects.generate', { 'content-type': 'application/json' }),
  );
  // 403 quota_exceeded is the plan's monthly allowance working, not an error.
  if (res.status === 403) quotaRefused.add(1);
  if (res.status === 202) generated.add(1);
  ok(res, 'projects.generate', generateLatency, [403, 429]);
}

const ACTIONS = [
  [
    30,
    (a) => {
      get(a, 'projects.list', '/projects?limit=20');
      get(a, 'me', '/me');
      get(a, 'notifications', '/notifications?limit=20');
    },
  ],
  [
    15,
    (a) =>
      get(
        a,
        'projects.get',
        `/projects/${a.projectIds[Math.floor(Math.random() * a.projectIds.length)]}`,
      ),
  ],
  [10, (a) => get(a, 'library.videos', '/library/videos?limit=24')],
  [
    10,
    (a) => {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
      get(a, 'publications.calendar', `/publications?from=${from}&to=${to}&limit=50`);
      get(a, 'drip.upcoming', `/businesses/${a.businessId}/drip-queue/upcoming`);
    },
  ],
  [
    10,
    (a) => {
      get(a, 'analytics.overview', '/analytics/overview');
      get(a, 'analytics.timeseries', '/analytics/timeseries?days=30&metric=views');
    },
  ],
  [
    10,
    (a) => {
      page(a, 'page.projects', '/projects');
      page(a, 'page.calendar', '/calendar');
    },
  ],
  [13, (a) => createProject(a)],
  // People generate a few videos a day, not a minute: 2 % of actions (≈ 65 in a 6-minute hold of
  // 200 users), on top of the 100-user burst scenario.
  [
    2,
    (a) => {
      const id = createProject(a);
      if (id) generate(a, id);
    },
  ],
];
const TOTAL = ACTIONS.reduce((n, [w]) => n + w, 0);

export function user() {
  const a = account();
  let pick = Math.random() * TOTAL;
  for (const [weight, action] of ACTIONS) {
    pick -= weight;
    if (pick <= 0) {
      action(a);
      break;
    }
  }
  sleep(3 + Math.random() * 5);
}

/** Many users press "generate" in the same second (the pipeline burst). */
export function pressGenerate() {
  const a = account();
  const id = createProject(a);
  if (id) generate(a, id);
}
