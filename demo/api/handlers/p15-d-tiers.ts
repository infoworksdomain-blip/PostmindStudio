// 15.D2 / decision P3 — plan usage sample handlers (GET /usage and the staff view
// GET /admin/organisations/:id/usage), shaped like src/lib/studio/services/plan-quotas.ts.
// 26.1: a Starter / Growth / Pro plan reports `studioPlan: true` and the window its allowance
// counts in (`period`: an ISO week for a weekly plan, else the calendar month). The demo
// organisation is on Growth monthly at 15.5 of its 20 videos (78 %; 23.3: two carousels counted ¼ each).
import { videosToQuarters } from '@/lib/studio/billing/allowance-units';
import { allowanceWindowFor } from '@/lib/studio/billing/plans';
import { allowancePeriod, currentPlan, currentTier, videoQuota } from '../billing-state';
import { DemoHttpError, route } from '../registry';

const TIERS = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const;
type Tier = (typeof TIERS)[number];

const QUOTAS: Record<
  Tier,
  { short: number | null; long: number | null; shortMax: number; longMax: number | null }
> = {
  BASIC: { short: 20, long: 0, shortMax: 30, longMax: 0 },
  STANDARD: { short: 60, long: 2, shortMax: 30, longMax: 180 },
  PLUS: { short: 150, long: 8, shortMax: 30, longMax: 360 },
  ENTERPRISE: { short: null, long: null, shortMax: 30, longMax: null },
};
const SCAN_LIMIT: Record<Tier, number | null> = {
  BASIC: 1,
  STANDARD: 3,
  PLUS: 10,
  ENTERPRISE: null,
};
const IMAGE_CAP: Record<Tier, number> = { BASIC: 20, STANDARD: 50, PLUS: 200, ENTERPRISE: 1000 };

function meter(used: number, limit: number | null, maxDurationSec: number | null) {
  const percent =
    limit === null ? null : Math.round(limit === 0 ? (used > 0 ? 100 : 0) : (used / limit) * 100);
  // 23.3: like plan-quotas.ts, the exact use in quarters of a video.
  return {
    used,
    limit,
    percent,
    maxDurationSec,
    usedQuarters: videosToQuarters(used),
    limitQuarters: limit === null ? null : videosToQuarters(limit),
  };
}

interface Allowance {
  limits?: { short: number | null; long: number | null };
  period?: 'week' | 'month';
  /** A Starter / Growth / Pro plan: no long videos (max 0 s). */
  studioPlan?: boolean;
}

function view(
  organisationId: string,
  tier: Tier,
  used: { short: number; long: number },
  businessId?: string | null,
  allowance: Allowance = {},
) {
  const now = Date.now();
  const period = allowance.period ?? 'month';
  const window = allowanceWindowFor(period, now);
  const month = allowanceWindowFor('month', now);
  const q = {
    ...QUOTAS[tier],
    ...allowance.limits,
    ...(allowance.studioPlan && { longMax: 0 }),
  };
  const videos = {
    short: meter(used.short, q.short, q.shortMax),
    long: meter(used.long, q.long, q.longMax),
  };
  const worst = Math.max(
    0,
    ...[videos.short, videos.long].map((m) => (m.limit ? (m.percent ?? 0) : 0)),
  );
  return {
    organisationId,
    planTier: tier,
    // Phase 18: quotas are enforced under Stripe billing; the demo's request gate enforces them.
    mode: 'enforce',
    month: window.key,
    period,
    ...(allowance.studioPlan && { studioPlan: true }),
    periodStart: window.start.toISOString(),
    resetsAt: window.end.toISOString(),
    thresholds: [80, 100],
    status: worst >= 100 ? 'exceeded' : worst >= 80 ? 'warning' : 'ok',
    videos,
    platforms:
      tier === 'BASIC'
        ? { rule: 'tiktok_instagram_plus_one', description: 'TikTok + Instagram + 1 more' }
        : { rule: 'all', description: 'All platforms' },
    scans: { businessesScanned: 2, limit: SCAN_LIMIT[tier] },
    ...(businessId && {
      imageGeneration: {
        businessId,
        month: month.key,
        used: 12,
        cap: IMAGE_CAP[tier],
        remaining: IMAGE_CAP[tier] - 12,
        resetsAt: month.end.toISOString(),
      },
    }),
  };
}

// The demo organisation's allowance and use follow the demo bar's plan switcher
// (../billing-state.ts): Growth at 15.5 of 20 by default (23.3: carousels count ¼), Starter at its
// limit, a weekly plan per ISO week, a trial at 1 of 2.
route('GET', '/usage', ({ query }) => {
  const { short, long } = videoQuota();
  return {
    usage: view(
      'org_demo',
      currentTier(),
      { short: short.used, long: long.used },
      query.get('businessId'),
      {
        limits: { short: short.limit, long: long.limit },
        period: allowancePeriod(),
        studioPlan: currentPlan() !== null,
      },
    ),
  };
});

route('GET', '/admin/organisations/:id/usage', ({ params, query }) => {
  const id = params.id?.trim();
  if (!id) throw new DemoHttpError(400, 'validation_error', 'Invalid organisation id');
  const raw = query.get('tier')?.toUpperCase();
  const requested = TIERS.find((t) => t === raw);
  if (raw && !requested) throw new DemoHttpError(400, 'validation_error', 'Invalid tier');
  const tier = requested ?? 'STANDARD';
  return {
    usage: {
      ...view(id, tier, { short: 50, long: 1 }, query.get('businessId')),
      tier: { value: tier, source: requested ? 'query' : 'last_generation' },
    },
  };
});
