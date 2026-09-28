// 15.D2 / decision P3 — plan usage sample handlers (GET /usage and the staff view
// GET /admin/organisations/:id/usage), shaped like src/lib/studio/services/plan-quotas.ts.
// The demo organisation is on Standard at 83 % of its short videos, so the app-shell banner shows.
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
  return { used, limit, percent, maxDurationSec };
}

function view(
  organisationId: string,
  tier: Tier,
  used: { short: number; long: number },
  businessId?: string | null,
) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const q = QUOTAS[tier];
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
    mode: 'warn',
    month: start.toISOString().slice(0, 7),
    periodStart: start.toISOString(),
    resetsAt: end.toISOString(),
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
        month: start.toISOString().slice(0, 7),
        used: 12,
        cap: IMAGE_CAP[tier],
        remaining: IMAGE_CAP[tier] - 12,
        resetsAt: end.toISOString(),
      },
    }),
  };
}

route('GET', '/usage', ({ query }) => ({
  usage: view('org_demo', 'STANDARD', { short: 50, long: 1 }, query.get('businessId')),
}));

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
