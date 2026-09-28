// Phase 14 track 3 (BACKLOG 14.11) sample handlers. Shapes match the real routes:
//   POST /feedback, GET /admin/feedback                    services/feedback.ts
//   GET|PUT /admin/organisations/:id/beta                  services/beta.ts
//   GET /admin/beta                                        services/beta-dashboard.ts
//   GET /admin/safety-audit, POST …/sample, …/:id/result   services/safety-audit.ts
import { DEMO_ORG_ID, DEMO_USER_ID } from '../ids';
import { sampleVideo, type SceneKind } from '../../media';
import { DemoHttpError, route } from '../registry';
import { OTHER_ORGS } from './admin-state';
import { ago, DAY, HOUR, nowIso } from './projects-store';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

// ------------------------------------------------------------------ feedback

type Kind = 'bug' | 'idea' | 'praise' | 'other';
const KINDS: Kind[] = ['bug', 'idea', 'praise', 'other'];

interface FeedbackRec {
  id: string;
  organisationId: string;
  userId: string;
  kind: Kind;
  message: string;
  projectId: string | null;
  screen: string;
  createdAt: string;
}

const feedback: FeedbackRec[] = [
  {
    id: 'fb-3',
    organisationId: DEMO_ORG_ID,
    userId: DEMO_USER_ID,
    kind: 'idea',
    message: 'Could the calendar show which posts were auto-published?',
    projectId: null,
    screen: '/calendar',
    createdAt: ago(5 * HOUR),
  },
  {
    id: 'fb-2',
    organisationId: OTHER_ORGS.harrogate,
    userId: 'user-harrogate-1',
    kind: 'bug',
    message: 'The preview froze on Safari after I changed the caption font.',
    projectId: null,
    screen: '/projects',
    createdAt: ago(DAY + 2 * HOUR),
  },
  {
    id: 'fb-1',
    organisationId: OTHER_ORGS.york,
    userId: 'user-york-1',
    kind: 'praise',
    message: 'The voiceover sounds just like our studio manager. Customers noticed.',
    projectId: null,
    screen: '/library',
    createdAt: ago(3 * DAY),
  },
];

route('POST', '/feedback', ({ body }) => {
  const b = obj(body);
  const kind = b.kind as Kind;
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  const screen = typeof b.screen === 'string' ? b.screen.trim() : '';
  if (!KINDS.includes(kind)) throw bad('kind must be bug, idea, praise or other');
  if (!message || message.length > 2000) throw bad('message must be 1–2000 characters');
  if (!screen.startsWith('/')) throw bad('screen must be an app path starting with /');
  const rec: FeedbackRec = {
    id: `fb-${feedback.length + 1}-${Date.now()}`,
    organisationId: DEMO_ORG_ID,
    userId: DEMO_USER_ID,
    kind,
    message,
    projectId: typeof b.projectId === 'string' ? b.projectId : null,
    screen,
    createdAt: nowIso(),
  };
  feedback.unshift(rec);
  return { status: 201, body: { feedback: rec } };
});

route('GET', '/admin/feedback', ({ query }) => {
  const kind = query.get('kind');
  const org = query.get('organisationId');
  const cohort = query.get('cohort');
  const limit = Math.min(100, Number(query.get('limit') ?? 50) || 50);
  const inCohort = (id: string) => !cohort || cohortOf.get(id)?.cohort === cohort;
  const rows = feedback.filter(
    (f) =>
      (!kind || f.kind === kind) &&
      (!org || f.organisationId === org) &&
      inCohort(f.organisationId),
  );
  return { data: rows.slice(0, limit), hasMore: rows.length > limit, nextCursor: null };
});

// ------------------------------------------------------------------ beta cohort

interface BetaRec {
  cohort: string;
  plusUntil: string | null;
  enrolledAt: string;
  updatedAt: string;
  updatedByUserId: string;
}

const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

const cohortOf = new Map<string, BetaRec>([
  [
    DEMO_ORG_ID,
    {
      cohort: 'beta-1',
      plusUntil: inDays(19),
      enrolledAt: ago(11 * DAY),
      updatedAt: ago(11 * DAY),
      updatedByUserId: 'staff-demo',
    },
  ],
  [
    OTHER_ORGS.harrogate,
    {
      cohort: 'beta-1',
      plusUntil: inDays(24),
      enrolledAt: ago(6 * DAY),
      updatedAt: ago(6 * DAY),
      updatedByUserId: 'staff-demo',
    },
  ],
  [
    OTHER_ORGS.york,
    {
      cohort: 'beta-1',
      plusUntil: ago(2 * DAY),
      enrolledAt: ago(32 * DAY),
      updatedAt: ago(32 * DAY),
      updatedByUserId: 'staff-demo',
    },
  ],
]);

const USAGE: Record<
  string,
  { generated: number; failed: number; published: number; cost: number }
> = {
  [DEMO_ORG_ID]: { generated: 23, failed: 2, published: 17, cost: 6_840 },
  [OTHER_ORGS.harrogate]: { generated: 9, failed: 3, published: 5, cost: 2_115 },
  [OTHER_ORGS.york]: { generated: 31, failed: 1, published: 28, cost: 8_902 },
};

const plusActive = (b: BetaRec) => Boolean(b.plusUntil && Date.parse(b.plusUntil) > Date.now());
const view = (organisationId: string, b: BetaRec) => ({
  organisationId,
  cohort: b.cohort,
  plusUntil: b.plusUntil,
  plusActive: plusActive(b),
  enrolledAt: b.enrolledAt,
  updatedAt: b.updatedAt,
  updatedByUserId: b.updatedByUserId,
});
const rate = (g: number, f: number) =>
  g + f === 0 ? null : Math.round((f / (g + f)) * 1000) / 1000;

route('GET', '/admin/organisations/:id/beta', ({ params }) => {
  const id = params.id ?? '';
  const b = cohortOf.get(id);
  return { organisationId: id, beta: b ? view(id, b) : null };
});

route('PUT', '/admin/organisations/:id/beta', ({ params, body }) => {
  const id = (params.id ?? '').trim();
  const b = obj(body);
  const cohort = typeof b.cohort === 'string' ? b.cohort.trim() : '';
  if (!id) throw bad('Invalid organisation id');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cohort))
    throw bad('cohort: lowercase letters, digits, - and _ only');
  const existing = cohortOf.get(id);
  let plusUntil: string | null;
  if (b.plusUntil === null) plusUntil = null;
  else if (typeof b.plusUntil === 'string') {
    if (Date.parse(b.plusUntil) <= Date.now()) throw bad('plusUntil must be in the future');
    plusUntil = b.plusUntil;
  } else plusUntil = existing ? existing.plusUntil : inDays(30);
  const rec: BetaRec = {
    cohort,
    plusUntil,
    enrolledAt: existing?.enrolledAt ?? nowIso(),
    updatedAt: nowIso(),
    updatedByUserId: DEMO_USER_ID,
  };
  cohortOf.set(id, rec);
  return { organisationId: id, beta: view(id, rec) };
});

route('GET', '/admin/beta', ({ query }) => {
  const days = Number(query.get('days') ?? 30) || 30;
  if (days < 1 || days > 90) throw bad('days must be 1–90');
  const cohort = query.get('cohort');
  const members = [...cohortOf.entries()].filter(([, b]) => !cohort || b.cohort === cohort);
  // Sample usage is for a 30-day window; scale it so the window selector visibly changes.
  const scale = days / 30;
  const organisations = members.map(([id, b]) => {
    const u = USAGE[id] ?? { generated: 0, failed: 0, published: 0, cost: 0 };
    const generated = Math.round(u.generated * scale);
    const failed = Math.round(u.failed * scale);
    return {
      ...view(id, b),
      videosGenerated: generated,
      videosFailed: failed,
      videosPublished: Math.round(u.published * scale),
      failureRate: rate(generated, failed),
      costPence: Math.round(u.cost * scale),
      feedbackCount: feedback.filter((f) => f.organisationId === id).length,
    };
  });
  const sum = (
    k: 'videosGenerated' | 'videosFailed' | 'videosPublished' | 'costPence' | 'feedbackCount',
  ) => organisations.reduce((t, o) => t + o[k], 0);
  return {
    days,
    since: new Date(Date.now() - days * DAY).toISOString(),
    cohorts: [...new Set([...cohortOf.values()].map((b) => b.cohort))],
    totals: {
      organisations: organisations.length,
      videosGenerated: sum('videosGenerated'),
      videosFailed: sum('videosFailed'),
      videosPublished: sum('videosPublished'),
      costPence: sum('costPence'),
      feedbackCount: sum('feedbackCount'),
      failureRate: rate(sum('videosGenerated'), sum('videosFailed')),
    },
    organisations,
    recentFeedback: feedback
      .filter((f) => members.some(([id]) => id === f.organisationId))
      .slice(0, 10),
  };
});

// ------------------------------------------------------------------ Trust & Safety audit

type Result = 'pending' | 'pass' | 'miss';

interface AuditRec {
  id: string;
  period: string;
  organisationId: string;
  publicationId: string;
  projectId: string;
  platform: string;
  platformUrl: string | null;
  publishedAt: string;
  result: Result;
  note: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  scene: SceneKind;
}

function lastPeriod(): string {
  const d = new Date();
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

const PLATFORMS = ['tiktok', 'instagram_reel', 'youtube_short', 'facebook'] as const;
const SCENES: SceneKind[] = ['sourdough', 'coffee', 'kitchen'];
const ORGS = [DEMO_ORG_ID, OTHER_ORGS.harrogate, OTHER_ORGS.york, OTHER_ORGS.kirkstall];

function sample(period: string, n: number, offset = 0): AuditRec[] {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const k = i + offset;
    const platform = PLATFORMS[k % PLATFORMS.length] ?? 'tiktok';
    return {
      id: `audit-${period}-${k}`,
      period,
      organisationId: ORGS[k % ORGS.length] ?? DEMO_ORG_ID,
      publicationId: `pub-audit-${period}-${k}`,
      projectId: `prj-audit-${k}`,
      platform,
      platformUrl:
        platform === 'tiktok' ? `https://www.tiktok.com/@leedssourdough/video/74${k}0000000` : null,
      publishedAt: new Date(Date.UTC(y, m - 1, 2 + ((k * 3) % 26), 9 + (k % 8))).toISOString(),
      result: 'pending',
      note: null,
      reviewedByUserId: null,
      reviewedAt: null,
      scene: SCENES[k % SCENES.length] ?? 'sourdough',
    };
  });
}

const audits: AuditRec[] = sample(lastPeriod(), 8);
// Two already reviewed, one of them a miss (so the miss rate shows).
Object.assign(audits[0] as AuditRec, {
  result: 'pass',
  reviewedByUserId: 'staff-demo',
  reviewedAt: ago(2 * DAY),
});
Object.assign(audits[1] as AuditRec, {
  result: 'miss',
  note: 'Knife held towards camera with no context; should have gone to review.',
  reviewedByUserId: 'staff-demo',
  reviewedAt: ago(DAY),
});

route('GET', '/admin/safety-audit', async ({ query }) => {
  const period = query.get('period') || lastPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad('period must be YYYY-MM');
  const result = query.get('result') as Result | null;
  const inPeriod = audits.filter((a) => a.period === period);
  const rows = inPeriod.filter((a) => !result || a.result === result);
  const n = (r: Result) => inPeriod.filter((a) => a.result === r).length;
  const reviewed = n('pass') + n('miss');
  const data = await Promise.all(
    rows.map(async ({ scene, ...a }) => ({
      ...a,
      previewUrl: (await sampleVideo({ scene, aspect: '9:16', seconds: 4 })) || null,
    })),
  );
  return {
    summary: {
      period,
      sampled: inPeriod.length,
      pending: n('pending'),
      passed: n('pass'),
      missed: n('miss'),
      missRate: reviewed ? Math.round((n('miss') / reviewed) * 1000) / 1000 : null,
    },
    periods: [...new Set(audits.map((a) => a.period))].sort().reverse(),
    data,
    hasMore: false,
    nextCursor: null,
  };
});

route('POST', '/admin/safety-audit/sample', ({ body }) => {
  const b = obj(body);
  const period = typeof b.period === 'string' ? b.period : lastPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad('period must be YYYY-MM');
  const size = typeof b.sampleSize === 'number' ? b.sampleSize : 50;
  const existing = audits.filter((a) => a.period === period).length;
  // The demo's sample population is small: 12 published videos in the month.
  const population = 12;
  const add = Math.max(0, Math.min(size, population) - existing);
  audits.push(...sample(period, add, existing));
  return {
    sample: { period, requested: size, added: add, total: existing + add, population },
  };
});

route('POST', '/admin/safety-audit/:id/result', ({ params, body }) => {
  const item = audits.find((a) => a.id === params.id);
  if (!item) throw new DemoHttpError(404, 'not_found', 'Audit item not found');
  const b = obj(body);
  const result = b.result;
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (result !== 'pass' && result !== 'miss') throw bad('result must be pass or miss');
  if (result === 'miss' && note.length < 3)
    throw bad('a miss needs a note (at least 3 characters) saying what was missed');
  if (item.result !== 'pending')
    throw new DemoHttpError(409, 'conflict', `Already recorded as ${item.result}`);
  Object.assign(item, {
    result,
    note: note || null,
    reviewedByUserId: DEMO_USER_ID,
    reviewedAt: nowIso(),
  });
  const { scene: _scene, ...rest } = item;
  return { item: { ...rest, previewUrl: null } };
});
