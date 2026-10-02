// Phase 13 track A3 (admin, automation and cost) sample handlers. Shapes match the real routes:
//   /admin/queues, /admin/providers                       13.16 (services/admin-health.ts)
//   /admin/safety-reviews, …/:id/decision                 13.17 (services/safety-reviews.ts)
//   /admin/organisations/:id/policy                       13.18 (services/org-policy.ts)
//   /admin/organisations/:id/cost-caps                    13.19 (services/org-cost-caps.ts)
//   /projects/:id/auto-publish, …/retry                   13.21 (automation/outbox.ts)
//   /internal/organisations/:id/purge                     13.22 (services/organisation-purge.ts)
//   /notification-preferences                             13.24 (notifications/preferences.ts)
// Plus two sample projects: one paused by the organisation's daily cap (13.20 auto-resume note)
// and one waiting for a content-safety review (13.17).
import { PLAN_CATALOGUE } from '@/lib/studio/billing/catalogue';
import { DEMO_ORG_ID, DEMO_USER_ID } from '../ids';
import { sampleVideo } from '../../media';
import { DemoHttpError, route } from '../registry';
import { demoRetrySchedule } from './p20-schedule-month';
import { OTHER_ORGS } from './admin-state';
import {
  ago,
  baseProject,
  DAY,
  getProject,
  HOUR,
  MIN,
  nowIso,
  putProject,
  setMeta,
  touch,
  type ProjectRec,
} from './projects-store';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

// ------------------------------------------------------------------ sample projects

export const A3_PROJECTS = {
  valentines: { id: 'prj-valentines-box', name: 'Valentine’s box pre-orders' },
  breadKnife: { id: 'prj-bread-knife', name: 'How we slice a country loaf' },
} as const;

const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);

putProject(
  baseProject(A3_PROJECTS.valentines.id, A3_PROJECTS.valentines.name, {
    state: 'FAILED',
    scene: 'cake',
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 20 }],
    costActualPence: 140,
    errorReason:
      'cost_cap_paused: organisation daily cost cap reached (£15.00 today, STANDARD tier); generation resumes after midnight UTC',
    createdAt: ago(20 * HOUR),
    updatedAt: ago(14 * HOUR),
    metadata: {
      costPause: {
        scope: 'org_daily',
        job: 'generate-asset',
        period: yesterday,
        at: ago(14 * HOUR),
      },
    },
  }),
);

putProject(
  baseProject(A3_PROJECTS.breadKnife.id, A3_PROJECTS.breadKnife.name, {
    state: 'QUALITY_CHECKING',
    scene: 'kitchen',
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
    costActualPence: 212,
    createdAt: ago(3 * HOUR),
    updatedAt: ago(40 * MIN),
    metadata: {
      safetyReview: {
        id: 'sr-bread-knife',
        kind: 'content',
        state: 'PENDING',
        reason: 'tiktok: Needs review: knife_in_hand=0.86',
        at: ago(40 * MIN),
      },
    },
  }),
);

// ------------------------------------------------------------------ 13.16 health

const LOADED = Date.now();
const secondsSince = (ms: number) => Math.round((Date.now() - (LOADED - ms)) / 1000);

route('GET', '/admin/queues', () => ({
  queues: [
    {
      name: 'studio-orchestration',
      waiting: 3,
      active: 2,
      failed: 0,
      delayed: 0,
      oldestWaitingSec: secondsSince(12_000),
    },
    {
      name: 'studio-assets',
      waiting: 14,
      active: 5,
      failed: 2,
      delayed: 0,
      oldestWaitingSec: secondsSince(41_000),
    },
    {
      name: 'studio-publish',
      waiting: 0,
      active: 1,
      failed: 1,
      delayed: 6,
      oldestWaitingSec: null,
    },
    {
      name: 'studio-scheduled',
      waiting: 0,
      active: 0,
      failed: 0,
      delayed: 11,
      oldestWaitingSec: null,
    },
    {
      name: 'studio-analytics',
      waiting: 22,
      active: 4,
      failed: 0,
      delayed: 138,
      oldestWaitingSec: secondsSince(7_000),
    },
    {
      name: 'studio-library',
      waiting: 0,
      active: 0,
      failed: 3,
      delayed: 0,
      oldestWaitingSec: null,
    },
  ],
}));

route('GET', '/admin/providers', () => ({
  providers: [
    {
      id: 'anthropic',
      configured: true,
      breaker: 'closed',
      errorRate1h: 0,
      jobs1h: { succeeded: 184, failed: 0, running: 3 },
      spendTodayPence: 2_310,
      healthy: true,
    },
    {
      id: 'assemblyai',
      configured: true,
      breaker: 'closed',
      errorRate1h: null,
      jobs1h: { succeeded: 0, failed: 0, running: 0 },
      spendTodayPence: 0,
      healthy: true,
    },
    {
      id: 'elevenlabs',
      configured: true,
      breaker: 'closed',
      errorRate1h: 0.011,
      jobs1h: { succeeded: 88, failed: 1, running: 2 },
      spendTodayPence: 960,
      healthy: true,
    },
    {
      id: 'elevenlabs-music',
      configured: true,
      breaker: 'closed',
      errorRate1h: 0,
      jobs1h: { succeeded: 21, failed: 0, running: 1 },
      spendTodayPence: 140,
      healthy: true,
    },
    {
      id: 'luma',
      configured: true,
      breaker: 'half_open',
      errorRate1h: 0.31,
      jobs1h: { succeeded: 9, failed: 4, running: 1 },
      spendTodayPence: 1_120,
      healthy: true,
    },
    {
      id: 'openai',
      configured: true,
      breaker: 'closed',
      errorRate1h: 0,
      jobs1h: { succeeded: 12, failed: 0, running: 0 },
      spendTodayPence: 64,
      healthy: true,
    },
    {
      id: 'runway',
      configured: true,
      breaker: 'open',
      errorRate1h: 0.02,
      jobs1h: { succeeded: 47, failed: 1, running: 5 },
      spendTodayPence: 1_840,
      // 20.11: held for an account problem; clips fail over to Luma meanwhile.
      accountHold: {
        errorClass: 'auth',
        reason: '401: The provided API key is not valid.',
        until: new Date(Date.now() + 12 * 60_000).toISOString(),
        since: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
      healthy: false,
    },
    {
      id: 'shotstack',
      configured: true,
      breaker: 'open',
      errorRate1h: 0.58,
      jobs1h: { succeeded: 5, failed: 7, running: 0 },
      spendTodayPence: 310,
      healthy: false,
    },
  ],
}));

// ------------------------------------------------------------------ 13.17 safety reviews

type ReviewState = 'PENDING' | 'ALLOWED' | 'BLOCKED';

interface DemoReview {
  id: string;
  organisationId: string;
  projectId: string;
  projectName: string;
  kind: 'script' | 'content';
  state: ReviewState;
  reason: string;
  scene?: 'kitchen' | 'coffee';
  scripts: Array<{ platform: string; excerpt: string }>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

const reviews: DemoReview[] = [
  {
    id: 'sr-bread-knife',
    organisationId: DEMO_ORG_ID,
    projectId: A3_PROJECTS.breadKnife.id,
    projectName: A3_PROJECTS.breadKnife.name,
    kind: 'content',
    state: 'PENDING',
    reason: 'tiktok: Needs review: knife_in_hand=0.86',
    scene: 'kitchen',
    scripts: [],
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: ago(40 * MIN),
  },
  {
    id: 'sr-harrogate-claims',
    organisationId: OTHER_ORGS.harrogate,
    projectId: 'prj-harrogate-mushroom-coffee',
    projectName: 'Mushroom coffee: the focus blend',
    kind: 'script',
    state: 'PENDING',
    reason:
      'Script safety REVIEW (medical_misinformation): claims the blend “boosts immunity and cures brain fog”',
    scripts: [
      {
        platform: 'tiktok',
        excerpt:
          'Brain fog? Our lion’s mane focus blend boosts immunity and cures brain fog in a week. Swap your latte for a clearer head — only at Harrogate Coffee Co.',
      },
    ],
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: ago(2 * HOUR),
  },
  {
    id: 'sr-york-stretch',
    organisationId: OTHER_ORGS.york,
    projectId: 'prj-york-yoga-classes',
    projectName: 'Autumn class timetable',
    kind: 'content',
    state: 'ALLOWED',
    reason: 'youtube_short: Needs review: general_suggestive=0.82',
    scene: 'coffee',
    scripts: [],
    decisionNote: 'Standard yoga clothing, class demo — fine.',
    decidedByUserId: 'staff-priya',
    decidedAt: ago(DAY - 2 * HOUR),
    createdAt: ago(DAY),
  },
  {
    id: 'sr-kirkstall-blades',
    organisationId: OTHER_ORGS.kirkstall,
    projectId: 'prj-kirkstall-cut-throat',
    projectName: 'Cut-throat shave special',
    kind: 'script',
    state: 'BLOCKED',
    reason: 'Script safety REVIEW (financial_scam): “win £500 cash, just share this video”',
    scripts: [],
    decisionNote: 'Prize promotion without terms — not allowed.',
    decidedByUserId: 'staff-priya',
    decidedAt: ago(2 * DAY),
    createdAt: ago(2 * DAY + HOUR),
  },
];

route('GET', '/admin/safety-reviews', async ({ query }) => {
  const state = (query.get('state') ?? 'PENDING') as ReviewState;
  if (!['PENDING', 'ALLOWED', 'BLOCKED'].includes(state)) throw bad('state is invalid');
  const rows = reviews
    .filter((r) => r.state === state)
    .sort((a, b) =>
      state === 'PENDING'
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
  const data = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      organisationId: r.organisationId,
      projectId: r.projectId,
      projectName: r.projectName,
      projectState:
        r.organisationId === DEMO_ORG_ID ? getProject(r.projectId).state : 'QUALITY_CHECKING',
      kind: r.kind,
      state: r.state,
      reason: r.reason,
      details: null,
      previewUrl:
        r.kind === 'content' && r.scene
          ? (await sampleVideo({ scene: r.scene, aspect: '9:16', seconds: 4 })) || null
          : null,
      scripts: r.scripts,
      decisionNote: r.decisionNote,
      decidedByUserId: r.decidedByUserId,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    })),
  );
  return {
    data,
    pendingCount: reviews.filter((r) => r.state === 'PENDING').length,
    hasMore: false,
    nextCursor: null,
  };
});

route('POST', '/admin/safety-reviews/:id/decision', ({ params, body }) => {
  const review = reviews.find((r) => r.id === params.id);
  if (!review) throw new DemoHttpError(404, 'not_found', 'Safety review not found');
  const b = obj(body);
  const decision = b.decision;
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (decision !== 'ALLOW' && decision !== 'BLOCK') throw bad('decision must be ALLOW or BLOCK');
  if (note.length < 3) throw bad('note must be at least 3 characters');
  if (review.state !== 'PENDING')
    throw new DemoHttpError(409, 'conflict', `This review was already decided (${review.state})`);
  review.state = decision === 'ALLOW' ? 'ALLOWED' : 'BLOCKED';
  review.decisionNote = note;
  review.decidedByUserId = DEMO_USER_ID;
  review.decidedAt = nowIso();
  let projectState: string | null = review.kind === 'script' ? 'ASSETS_QUEUED' : 'READY_FOR_REVIEW';
  if (decision === 'BLOCK') projectState = 'FAILED';
  if (review.organisationId === DEMO_ORG_ID) {
    const p = getProject(review.projectId);
    setMeta(p, {
      safetyReview: { ...obj(p.metadata?.safetyReview), state: review.state, note, at: nowIso() },
    });
    touch(
      p,
      decision === 'BLOCK'
        ? { state: 'FAILED', errorReason: `${review.kind}_safety_blocked_by_review: ${note}` }
        : { state: 'READY_FOR_REVIEW', completedAt: nowIso() },
    );
    projectState = p.state;
  }
  return {
    review: { id: review.id, state: review.state, decisionNote: note, decidedAt: review.decidedAt },
    project: { id: review.projectId, state: projectState },
  };
});

// ------------------------------------------------------------------ 13.18 policy, 13.19 caps

type ReviewPolicy = 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'REQUIRE_APPROVAL_FROM_ROLE';
interface PolicyRow {
  defaultReviewPolicy: ReviewPolicy | null;
  autoApproveAllowed: boolean;
  autoApproveTrustThreshold: number | null;
  updatedAt: string;
  updatedByUserId: string;
}

const policies = new Map<string, PolicyRow>([
  [
    OTHER_ORGS.harrogate,
    {
      defaultReviewPolicy: 'REQUIRE_APPROVAL_FROM_ROLE',
      autoApproveAllowed: false,
      autoApproveTrustThreshold: null,
      updatedAt: ago(6 * DAY),
      updatedByUserId: 'staff-priya',
    },
  ],
]);

const POLICIES: ReviewPolicy[] = ['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'REQUIRE_APPROVAL_FROM_ROLE'];
const ENV_THRESHOLD = 10;

function policyView(organisationId: string) {
  const row = policies.get(organisationId);
  return {
    organisationId,
    policy: {
      defaultReviewPolicy: row?.defaultReviewPolicy ?? 'REQUIRE_APPROVAL',
      autoApproveTrustThreshold: row?.autoApproveTrustThreshold ?? ENV_THRESHOLD,
      autoApproveAllowed: row?.autoApproveAllowed ?? true,
    },
    source: {
      defaultReviewPolicy: row?.defaultReviewPolicy ? 'organisation' : 'default',
      autoApproveTrustThreshold:
        row?.autoApproveTrustThreshold != null ? 'organisation' : 'default',
      autoApproveAllowed: row ? 'organisation' : 'default',
    },
    updatedAt: row?.updatedAt ?? null,
    updatedByUserId: row?.updatedByUserId ?? null,
  };
}

route('GET', '/admin/organisations/:id/policy', ({ params }) => policyView(params.id ?? ''));

route('PUT', '/admin/organisations/:id/policy', ({ params, body }) => {
  const b = obj(body);
  const keys = Object.keys(b);
  if (keys.length === 0) throw bad('Send at least one policy field');
  const known = ['defaultReviewPolicy', 'autoApproveAllowed', 'autoApproveTrustThreshold'];
  if (keys.some((k) => !known.includes(k))) throw bad('Unknown policy field');
  if (b.defaultReviewPolicy != null && !POLICIES.includes(b.defaultReviewPolicy as ReviewPolicy))
    throw bad('defaultReviewPolicy is invalid');
  const t = b.autoApproveTrustThreshold;
  if (t != null && (!Number.isInteger(t) || (t as number) < 1 || (t as number) > 1000))
    throw bad('autoApproveTrustThreshold must be 1–1000');
  const id = params.id ?? '';
  const current = policies.get(id);
  policies.set(id, {
    defaultReviewPolicy:
      b.defaultReviewPolicy !== undefined
        ? (b.defaultReviewPolicy as ReviewPolicy | null)
        : (current?.defaultReviewPolicy ?? null),
    autoApproveAllowed:
      typeof b.autoApproveAllowed === 'boolean'
        ? b.autoApproveAllowed
        : (current?.autoApproveAllowed ?? true),
    autoApproveTrustThreshold:
      t !== undefined ? (t as number | null) : (current?.autoApproveTrustThreshold ?? null),
    updatedAt: nowIso(),
    updatedByUserId: DEMO_USER_ID,
  });
  return policyView(id);
});

const TIERS = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const;
const DAILY = Object.fromEntries(
  TIERS.map((t) => [t, PLAN_CATALOGUE[t].dailyCostCapPence]),
) as Record<(typeof TIERS)[number], number>;
const MONTHLY = Object.fromEntries(
  TIERS.map((t) => [t, PLAN_CATALOGUE[t].monthlyCostCapPence]),
) as Record<(typeof TIERS)[number], number>;

interface CapRow {
  dailyPence: number | null;
  monthlyPence: number | null;
  reason: string;
  updatedByUserId: string;
  updatedAt: string;
}

/** Shared with /admin/cost/caps (admin-cost.ts) so the report lists overrides. */
export const capOverrides = new Map<string, CapRow>([
  [
    OTHER_ORGS.york,
    {
      dailyPence: 20_000,
      monthlyPence: 100_000,
      reason: 'Pilot, agreed with Commercial',
      updatedByUserId: 'staff-priya',
      updatedAt: ago(9 * DAY),
    },
  ],
]);

function capsView(organisationId: string) {
  const row = capOverrides.get(organisationId) ?? null;
  const view = (kind: 'daily' | 'monthly') => {
    const own = kind === 'daily' ? row?.dailyPence : row?.monthlyPence;
    const table = kind === 'daily' ? DAILY : MONTHLY;
    return {
      pence: own ?? null,
      source: own != null ? 'org_override' : 'plan_tier',
      byTier: Object.fromEntries(
        TIERS.map((tier) => [
          tier,
          own != null
            ? { pence: own, source: 'org_override' }
            : { pence: table[tier], source: 'default' },
        ]),
      ),
    };
  };
  return {
    organisationId,
    caps: { daily: view('daily'), monthly: view('monthly') },
    override: row,
  };
}

route('GET', '/admin/organisations/:id/cost-caps', ({ params }) => capsView(params.id ?? ''));

route('PUT', '/admin/organisations/:id/cost-caps', ({ params, body }) => {
  const b = obj(body);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 3) throw bad('reason must be at least 3 characters');
  if (b.dailyPence === undefined && b.monthlyPence === undefined)
    throw bad('Send dailyPence and/or monthlyPence (null clears an override)');
  const check = (v: unknown) =>
    v === null ||
    v === undefined ||
    (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000_000);
  if (!check(b.dailyPence) || !check(b.monthlyPence)) throw bad('Caps must be 1–10,000,000 pence');
  const id = params.id ?? '';
  const current = capOverrides.get(id);
  capOverrides.set(id, {
    dailyPence:
      b.dailyPence !== undefined ? (b.dailyPence as number | null) : (current?.dailyPence ?? null),
    monthlyPence:
      b.monthlyPence !== undefined
        ? (b.monthlyPence as number | null)
        : (current?.monthlyPence ?? null),
    reason,
    updatedByUserId: DEMO_USER_ID,
    updatedAt: nowIso(),
  });
  return capsView(id);
});

// ------------------------------------------------------------------ 13.21 auto-publish outbox

interface OutboxRow {
  id: string;
  targetIndex: number;
  target: { platform: string; account: string | null; scheduleOffsetMinutes: number | null };
  trigger: 'human' | 'auto';
  state: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  publicationId: string | null;
  createdAt: string;
  updatedAt: string;
}

const outboxes = new Map<string, OutboxRow[]>();

/** Rows derived from the project's targets and metadata.autoPublishResult on first read. */
function outboxFor(p: ProjectRec): OutboxRow[] {
  const approved = p.approvals.find((a) => a.state === 'APPROVED');
  if (p.publishPolicy !== 'AUTO_ON_APPROVAL' || !approved) return [];
  const existing = outboxes.get(p.id);
  if (existing) return existing;
  const targets = (obj(obj(p.metadata).autoPublish).targets as unknown[] | undefined) ?? [];
  const results = (obj(obj(p.metadata).autoPublishResult).results as unknown[] | undefined) ?? [];
  const at = approved.createdAt ?? p.updatedAt;
  const rows = targets.map((raw, i): OutboxRow => {
    const t = obj(raw);
    const result = obj(results.find((r) => obj(r).index === i));
    const failed = result.status === 'failed';
    return {
      id: `apo-${p.id}-${i}`,
      targetIndex: i,
      target: {
        platform: String(t.platform ?? 'tiktok'),
        account: (t.connectionId ?? t.platformAccountId ?? null) as string | null,
        scheduleOffsetMinutes: (t.scheduleOffsetMinutes as number | undefined) ?? null,
      },
      trigger: approved.resolvedByUserId?.startsWith('system:') ? 'auto' : 'human',
      state: failed ? 'FAILED' : 'SENT',
      attempts: failed ? 5 : 1,
      maxAttempts: 5,
      nextAttemptAt: null,
      lastError: failed ? String(result.error ?? 'Publishing failed') : null,
      publicationId: failed
        ? null
        : ((result.publicationId as string | undefined) ?? `pub-${p.id}-${i}`),
      createdAt: at,
      updatedAt: at,
    };
  });
  outboxes.set(p.id, rows);
  return rows;
}

route('GET', '/projects/:id/auto-publish', ({ params }) => {
  const p = getProject(params.id ?? '');
  return { projectId: p.id, publishPolicy: p.publishPolicy, outbox: outboxFor(p) };
});

route('POST', '/projects/:id/auto-publish/retry', ({ params }) => {
  const p = getProject(params.id ?? '');
  // 20.3: a SCHEDULED project that got no drip slot is planned again (p20-schedule-month.ts).
  const scheduled = demoRetrySchedule(p);
  if (scheduled) return { status: 202, body: { requeued: 0, ...scheduled } };
  const rows = outboxFor(p);
  let requeued = 0;
  for (const row of rows) {
    if (row.state !== 'FAILED') continue;
    requeued += 1;
    Object.assign(row, {
      state: 'SENT',
      attempts: 1,
      lastError: null,
      publicationId: `pub-${p.id}-${row.targetIndex}-retry`,
      updatedAt: nowIso(),
    });
  }
  return { status: 202, body: { requeued, scheduled: 0, unscheduled: null } };
});

// ------------------------------------------------------------------ 13.22 purge (internal)

route('POST', '/internal/organisations/:id/purge', ({ params }) => {
  const now = Date.now();
  return {
    status: 202,
    body: {
      purge: {
        organisationId: params.id ?? '',
        channelsWiped: 2,
        projectsDeleted: 14,
        publicationsCancelled: 1,
        requestedAt: new Date(now).toISOString(),
        graceUntil: new Date(now + 30 * DAY).toISOString(),
        repeated: false,
      },
    },
  };
});

// ------------------------------------------------------------------ 13.24 preferences

const KINDS = [
  'cost_alert',
  'cost_paused',
  'publication_failed',
  'generation_complete',
  'approval_pending',
  'safety_review',
  'auto_publish_failed',
  'milestone',
  'share_comment',
  'plan_quota',
] as const;

const prefs = new Map<string, { inApp: boolean; email: boolean }>(
  KINDS.map((k) => [k, { inApp: true, email: k === 'publication_failed' }]),
);

const prefsBody = () => ({
  preferences: Object.fromEntries(KINDS.map((k) => [k, prefs.get(k)])),
  emailDelivery: 'pending_setup',
});

route('GET', '/notification-preferences', () => prefsBody());

route('PATCH', '/notification-preferences', ({ body }) => {
  const b = obj(body);
  const entries = Object.entries(b);
  if (entries.length === 0) throw bad('Nothing to update');
  for (const [kind, raw] of entries) {
    if (!(KINDS as readonly string[]).includes(kind))
      throw bad(`Unknown notification kind ${kind}`);
    const change = obj(raw);
    const current = prefs.get(kind) ?? { inApp: true, email: false };
    prefs.set(kind, {
      inApp: typeof change.inApp === 'boolean' ? change.inApp : current.inApp,
      email: typeof change.email === 'boolean' ? change.email : current.email,
    });
  }
  return prefsBody();
});
