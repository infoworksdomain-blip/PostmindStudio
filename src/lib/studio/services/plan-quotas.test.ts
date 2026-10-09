import pino from 'pino';
import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { QuotaExceededError } from '../../errors';
import type { NotificationInput, Notifier } from '../notifications/notifier';
import type { Entitlements } from '../billing/entitlements-reader';
import {
  allowanceWindow,
  planAllowanceNotice,
  checkGenerateQuota,
  checkPublishQuota,
  DEFAULT_TIER_QUOTAS,
  entitlementQuota,
  generateViolations,
  meter,
  monthlyQuarterUsage,
  notifyQuotaThresholds,
  quotaMode,
  reachedThresholds,
  tierQuota,
  usageView,
  videoKind,
  videoLimitViolations,
} from './plan-quotas';
import { monthWindow } from './tier-gates';
import { buildFormats, PLATFORM_OPTIONS } from '../../../components/studio/create/formats';

const logger = pino({ level: 'silent' });
const SEPT = Date.parse('2026-09-28T12:00:00Z');

interface Row {
  id: string;
  organisationId: string;
  sourceType: string;
  targetFormats: unknown;
  metadata: unknown;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const fmt = (durationSec: number, platform = 'tiktok') => [
  { platform, aspectRatio: '9:16', duration: durationSec },
];
const generated = (at: string) => ({ runId: 'r', generationStart: { runId: 'r', at } });

function fakeDb(rows: Row[], extra: Record<string, unknown> = {}) {
  return {
    videoProject: {
      findMany: vi.fn(
        async ({ where }: { where: { organisationId: string; updatedAt?: { gte: Date } } }) =>
          rows.filter(
            (r) =>
              r.organisationId === where.organisationId &&
              (!where.updatedAt || r.updatedAt >= where.updatedAt.gte),
          ),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; organisationId: string } }) =>
          rows.find((r) => r.id === where.id && r.organisationId === where.organisationId) ?? null,
      ),
    },
    websiteScan: { findMany: vi.fn(async () => [{ businessId: 'b1' }]) },
    imageLibraryItem: { count: vi.fn(async () => 3) },
    ...extra,
  };
}

function row(id: string, seconds: number, at: string | null, extra: Partial<Row> = {}): Row {
  return {
    id,
    organisationId: 'org-1',
    sourceType: 'BRIEF',
    targetFormats: fmt(seconds),
    metadata: at ? generated(at) : {},
    updatedAt: new Date(at ?? '2026-09-02T00:00:00Z'),
    ...extra,
  };
}

const tenantOn = (planTier: string) => ({
  organisationId: 'org-1',
  organisation: { id: 'org-1', planTier },
});

describe('spec 12.4 defaults and env (decision P3)', () => {
  it('matches the spec table', () => {
    expect(DEFAULT_TIER_QUOTAS.BASIC).toMatchObject({ shortVideos: 20, longVideos: 0 });
    expect(DEFAULT_TIER_QUOTAS.STANDARD).toMatchObject({
      shortVideos: 40,
      longVideos: 1,
      longMaxSec: 180,
    });
    expect(DEFAULT_TIER_QUOTAS.PLUS).toMatchObject({
      shortVideos: 80,
      longVideos: 4,
      longMaxSec: 360,
    });
    expect(DEFAULT_TIER_QUOTAS.ENTERPRISE).toMatchObject({ shortVideos: null, longVideos: null });
    for (const t of ['BASIC', 'STANDARD', 'PLUS'] as const)
      expect(DEFAULT_TIER_QUOTAS[t].shortMaxSec).toBe(30);
  });

  it('reads overrides, "unlimited" and the mode (default warn)', () => {
    expect(
      tierQuota('BASIC', { STUDIO_QUOTA_BASIC_SHORT: '25', STUDIO_QUOTA_BASIC_LONG: 'unlimited' }),
    ).toMatchObject({ shortVideos: 25, longVideos: null });
    expect(tierQuota('BASIC', { STUDIO_QUOTA_BASIC_SHORT: '-1' }).shortVideos).toBe(20);
    expect(quotaMode({})).toBe('warn');
    expect(quotaMode({ STUDIO_QUOTA_MODE: 'ENFORCE' })).toBe('enforce');
    expect(quotaMode({ STUDIO_QUOTA_MODE: 'block' })).toBe('warn');
  });
});

describe('classification and per-video limits', () => {
  const basic = DEFAULT_TIER_QUOTAS.BASIC;
  it('is long past 30 s; slideshows are always short', () => {
    expect(videoKind({ sourceType: 'BRIEF', targetFormats: fmt(30) }, basic)).toBe('short');
    expect(videoKind({ sourceType: 'BRIEF', targetFormats: fmt(31) }, basic)).toBe('long');
    expect(videoKind({ sourceType: 'SLIDESHOW', targetFormats: fmt(60) }, basic)).toBe('short');
  });

  it('refuses long videos on Basic and over-length ones on Standard', () => {
    expect(
      videoLimitViolations({ sourceType: 'BRIEF', targetFormats: fmt(45) }, basic, 'BASIC').map(
        (v) => v.code,
      ),
    ).toEqual(['long_not_included']);
    const std = DEFAULT_TIER_QUOTAS.STANDARD;
    expect(
      videoLimitViolations({ sourceType: 'BRIEF', targetFormats: fmt(180) }, std, 'STANDARD'),
    ).toEqual([]);
    expect(
      videoLimitViolations({ sourceType: 'BRIEF', targetFormats: fmt(181) }, std, 'STANDARD').map(
        (v) => v.code,
      ),
    ).toEqual(['duration']);
  });

  it('allows TikTok + Instagram + 1 more on Basic', () => {
    const project = {
      sourceType: 'BRIEF',
      targetFormats: [
        ...fmt(20, 'tiktok'),
        ...fmt(20, 'instagram_reel'),
        ...fmt(20, 'instagram_feed'),
        ...fmt(20, 'youtube_short'),
      ],
    };
    expect(videoLimitViolations(project, basic, 'BASIC')).toEqual([]);
    expect(
      videoLimitViolations(project, basic, 'BASIC', ['linkedin_video']).map((v) => v.code),
    ).toEqual(['platforms']);
    expect(
      videoLimitViolations(project, DEFAULT_TIER_QUOTAS.STANDARD, 'STANDARD', ['x', 'facebook']),
    ).toEqual([]);
  });

  it('counts the quota only for a video not already counted this month', () => {
    const project = { sourceType: 'BRIEF', targetFormats: fmt(20) };
    const full = { short: 80, long: 0 }; // quarters: 20 videos
    expect(
      generateViolations({
        project,
        alreadyCounted: false,
        usage: full,
        quota: basic,
        tier: 'BASIC',
      }).map((v) => v.code),
    ).toEqual(['short_quota']);
    expect(
      generateViolations({
        project,
        alreadyCounted: true,
        usage: full,
        quota: basic,
        tier: 'BASIC',
      }),
    ).toEqual([]);
    expect(
      generateViolations({
        project,
        alreadyCounted: false,
        usage: { short: 10_000, long: 10_000 },
        quota: DEFAULT_TIER_QUOTAS.ENTERPRISE,
        tier: 'ENTERPRISE',
      }),
    ).toEqual([]);
  });
});

describe('monthly counting (UTC month boundary)', () => {
  it('counts generations started inside the month only', async () => {
    const db = fakeDb([
      row('aug', 20, '2026-08-31T23:59:59.999Z', { updatedAt: new Date('2026-09-03T00:00:00Z') }),
      row('first', 20, '2026-09-01T00:00:00.000Z'),
      row('long', 90, '2026-09-10T00:00:00.000Z'),
      row('never', 20, null),
      row('other-org', 20, '2026-09-10T00:00:00Z', { organisationId: 'org-2' }),
    ]);
    const usage = await monthlyQuarterUsage(
      db as never,
      'org-1',
      DEFAULT_TIER_QUOTAS.STANDARD,
      monthWindow(SEPT),
    );
    expect(usage).toEqual({ short: 4, long: 4 }); // one video each, in quarters
    const oct = await monthlyQuarterUsage(
      db as never,
      'org-1',
      DEFAULT_TIER_QUOTAS.STANDARD,
      monthWindow(Date.parse('2026-10-01T00:00:00Z')),
    );
    expect(oct).toEqual({ short: 0, long: 0 });
  });
});

describe('checkGenerateQuota: warn vs enforce', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => row(`p${i}`, 20, '2026-09-05T00:00:00Z')),
    row('next', 20, null),
  ];

  it('warn logs and allows', async () => {
    const info = vi.fn();
    const out = await checkGenerateQuota(
      {
        db: fakeDb(rows) as never,
        logger: { info } as never,
        now: () => SEPT,
        env: {},
      },
      tenantOn('BASIC'),
      'next',
    );
    expect(out.mode).toBe('warn');
    expect(out.violations.map((v) => v.code)).toEqual(['short_quota']);
    expect(info).toHaveBeenCalledOnce();
  });

  it('enforce answers 403 quota_exceeded with an upgrade message', async () => {
    const err = await checkGenerateQuota(
      {
        db: fakeDb(rows) as never,
        logger,
        now: () => SEPT,
        env: { STUDIO_QUOTA_MODE: 'enforce' },
      },
      tenantOn('BASIC'),
      'next',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).status).toBe(403);
    expect((err as QuotaExceededError).message).toMatch(/Upgrade to Standard/);
  });

  it('enforce lets an already counted video regenerate, and ignores unknown projects', async () => {
    const deps = {
      db: fakeDb(rows) as never,
      logger,
      now: () => SEPT,
      env: { STUDIO_QUOTA_MODE: 'enforce' },
    };
    await expect(checkGenerateQuota(deps, tenantOn('BASIC'), 'p3')).resolves.toMatchObject({
      violations: [],
    });
    await expect(checkGenerateQuota(deps, tenantOn('BASIC'), 'nope')).resolves.toMatchObject({
      violations: [],
    });
  });
});

describe('checkPublishQuota', () => {
  it('enforces the Basic platform rule on the publication platform', async () => {
    const db = {
      videoRender: {
        findFirst: vi.fn(async () => ({
          project: { sourceType: 'BRIEF', targetFormats: [...fmt(20), ...fmt(20, 'x')] },
        })),
      },
      videoProject: { findMany: vi.fn(), findFirst: vi.fn() },
    };
    const deps = {
      db: db as never,
      logger,
      now: () => SEPT,
      env: { STUDIO_QUOTA_MODE: 'enforce' },
    };
    await expect(
      checkPublishQuota(deps, tenantOn('BASIC'), { renderId: 'r', platform: 'linkedin_video' }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(
      checkPublishQuota(deps, tenantOn('BASIC'), { renderId: 'r', platform: 'instagram_reel' }),
    ).resolves.toMatchObject({ violations: [] });
  });
});

describe('usage view and threshold alerts', () => {
  const rows = Array.from({ length: 17 }, (_, i) => row(`p${i}`, 20, '2026-09-05T00:00:00Z'));

  it('reports meters, status and resets', async () => {
    const view = await usageView(
      { db: fakeDb(rows) as never, now: () => SEPT, env: {} },
      'org-1',
      'BASIC',
      'b1',
    );
    expect(view).toMatchObject({
      month: '2026-09',
      resetsAt: '2026-10-01T00:00:00.000Z',
      mode: 'warn',
      status: 'warning',
      videos: {
        short: { used: 17, limit: 20, percent: 85, usedQuarters: 68, limitQuarters: 80 },
        long: { used: 0, limit: 0 },
      },
      scans: { businessesScanned: 1, limit: 1 },
      imageGeneration: { businessId: 'b1', used: 3, cap: 20 },
    });
    expect(reachedThresholds(view.videos.short)).toEqual([80]);
    expect(reachedThresholds(view.videos.long)).toEqual([]);
  });

  it('notifies once per (month, kind, threshold): the dedupeKey makes repeats no-ops', async () => {
    const seen = new Set<string>();
    const sent: NotificationInput[] = [];
    const notifier: Notifier = {
      notify: vi.fn(async (input: NotificationInput) => {
        const created = !seen.has(input.dedupeKey ?? '');
        seen.add(input.dedupeKey ?? '');
        if (created) sent.push(input);
        return { created };
      }),
      notifyStaff: vi.fn(async () => 0),
    };
    const all = [
      ...rows,
      ...Array.from({ length: 3 }, (_, i) => row(`q${i}`, 20, '2026-09-06T00:00:00Z')),
    ];
    const deps = {
      db: fakeDb(all) as unknown as PrismaClient,
      logger,
      now: () => SEPT,
      env: {},
      notifier,
    };
    await notifyQuotaThresholds(deps, tenantOn('BASIC'));
    await notifyQuotaThresholds(deps, tenantOn('BASIC'));
    expect(sent.map((n) => n.dedupeKey)).toEqual([
      'plan-quota:2026-09:short:80',
      'plan-quota:2026-09:short:100',
    ]);
    expect(sent[0]).toMatchObject({ kind: 'plan_quota', organisationId: 'org-1' });
  });

  it('never throws when counting fails', async () => {
    const db = fakeDb([]);
    db.videoProject.findMany.mockRejectedValueOnce(new Error('db down'));
    const error = vi.fn();
    await expect(
      notifyQuotaThresholds(
        {
          db: db as unknown as PrismaClient,
          logger: { error } as never,
          now: () => SEPT,
          env: {},
        },
        tenantOn('BASIC'),
      ),
    ).resolves.toBe(0);
    expect(error).toHaveBeenCalled();
  });
});

describe('26.1 plan allowance (Starter 8 / Growth 20 / Pro 45 a month; 2 / 5 / 11 a week)', () => {
  type PlanId = 'starter' | 'growth' | 'pro';
  const planEnt = (id: PlanId, interval: 'week' | 'month' | 'year'): Entitlements => ({
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    limits: { seats: 3, businesses: 1, storageGb: 100 },
    plan: { id, interval, source: 'stripe' },
  });
  const base = tierQuota('STANDARD', {});

  it("the allowance is the plan's videos per window, with no long videos", () => {
    expect(entitlementQuota(base, planEnt('growth', 'month'))).toMatchObject({
      shortVideos: 20,
      longVideos: 0,
      longMaxSec: 0,
      studioPlan: true,
      period: 'month',
    });
    expect(entitlementQuota(base, planEnt('pro', 'year'))).toMatchObject({
      shortVideos: 45,
      period: 'month',
    });
    expect(entitlementQuota(base, planEnt('pro', 'week'))).toMatchObject({
      shortVideos: 11,
      period: 'week',
    });
    expect(entitlementQuota(base, planEnt('starter', 'month')).shortVideos).toBe(8);
    expect(entitlementQuota(base, planEnt('starter', 'week')).shortVideos).toBe(2);
    expect(entitlementQuota(base, planEnt('growth', 'week')).shortVideos).toBe(5);
  });

  it('a Create default video (every platform, Short) counts as short and is allowed', () => {
    // Regression: YouTube Shorts defaulted to 45 s, over the 30 s short limit, so the video
    // counted as long and a plan with no long videos refused it (long_not_included).
    const quota = entitlementQuota(base, planEnt('growth', 'month'));
    const project = {
      sourceType: 'BRIEF',
      targetFormats: buildFormats(
        PLATFORM_OPTIONS.map((o) => o.platform),
        'short',
      ) as unknown as Prisma.JsonValue,
      metadata: null,
    };
    expect(videoKind(project, quota)).toBe('short');
    expect(videoLimitViolations(project, quota, 'STANDARD')).toEqual([]);
    expect(
      generateViolations({
        project,
        alreadyCounted: false,
        usage: { short: 0, long: 0 },
        quota,
        tier: 'STANDARD',
      }),
    ).toEqual([]);
    // The old 45 s Short would have been refused.
    const old = {
      ...project,
      targetFormats: [{ platform: 'youtube_short', aspectRatio: '9:16', durationSec: 45 }],
    };
    expect(videoLimitViolations(old, quota, 'STANDARD').map((v) => v.code)).toEqual([
      'long_not_included',
    ]);
  });

  it('staff custom limits still win; a trial keeps its own allowance', () => {
    expect(
      entitlementQuota(base, { ...planEnt('growth', 'month'), custom: { shortVideos: 50 } })
        .shortVideos,
    ).toBe(50);
    const trial = {
      startedAt: '2026-09-20T00:00:00Z',
      endsAt: '2026-10-04T00:00:00Z',
      shortVideos: 2,
      longVideos: 0,
      dailyCostCapPence: 1_000,
      totalCostCapPence: 1_500,
    };
    expect(entitlementQuota(base, { ...planEnt('pro', 'month'), trial })).toMatchObject({
      shortVideos: 2,
      longVideos: 0,
      longMaxSec: 0,
    });
  });

  it('weekly plans count per ISO week; everything else per calendar month', () => {
    // Monday 28 September 2026 is the start of W40.
    expect(allowanceWindow(planEnt('starter', 'week'), SEPT)).toEqual({
      key: '2026-W40',
      start: new Date('2026-09-28T00:00:00Z'),
      end: new Date('2026-10-05T00:00:00Z'),
    });
    expect(allowanceWindow(planEnt('pro', 'year'), SEPT).key).toBe('2026-09');
    expect(allowanceWindow(undefined, SEPT).key).toBe('2026-09');
  });

  it('a long video is not part of any plan', () => {
    const quota = entitlementQuota(base, planEnt('starter', 'month'));
    expect(videoLimitViolations(row('l', 120, null) as never, quota, 'STANDARD')).toEqual([
      expect.objectContaining({
        code: 'long_not_included',
        message: expect.stringMatching(/^Your plan/),
      }),
    ]);
  });

  it('usage counts the weekly window and says so; messages never name a tier', async () => {
    const rows = [
      row('a', 20, '2026-09-28T09:00:00Z'), // this week
      row('b', 20, '2026-09-27T09:00:00Z'), // last week (same month)
    ];
    const view = await usageView(
      { db: fakeDb(rows) as never, now: () => SEPT, env: {} },
      'org-1',
      'STANDARD',
      undefined,
      planEnt('starter', 'week'),
    );
    expect(view).toMatchObject({
      month: '2026-W40',
      period: 'week',
      studioPlan: true,
      resetsAt: '2026-10-05T00:00:00.000Z',
      videos: { short: { used: 1, limit: 2 } },
    });
    const violations = generateViolations({
      project: row('c', 20, null) as never,
      alreadyCounted: false,
      usage: { short: 8, long: 0 }, // quarters: 2 videos
      quota: entitlementQuota(base, planEnt('starter', 'week')),
      tier: 'STANDARD',
    });
    expect(violations[0]?.message).toBe(
      'Your plan includes 2 short videos a week and 2 have been used',
    );
  });

  it('enforce answers quota_exceeded with "upgrade your plan or buy a video pack"', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`p${i}`, 20, '2026-09-05T00:00:00Z'));
    const target = row('new', 20, null);
    const db: Record<string, unknown> = fakeDb([...rows, target], {
      $executeRaw: async () => 0,
      usageCreditUse: { findUnique: async () => null },
      usageCredit: { findMany: async () => [] },
    });
    db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
    const reader = {
      forOrganisation: async () => planEnt('starter', 'month'),
      invalidate: () => undefined,
    };
    const err = await checkGenerateQuota(
      { db: db as never, logger, now: () => SEPT, env: {}, entitlements: reader },
      tenantOn('STANDARD'),
      'new',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as Error).message).toMatch(/Upgrade your plan or buy a video pack for more\.$/);
    expect((err as QuotaExceededError).details).toMatchObject({ studioPlan: true });
  });

  it('allowance notices name the week or month and the ways to keep going', () => {
    const view = { period: 'week' as const, resetsAt: '2026-10-05T00:00:00.000Z' };
    expect(planAllowanceNotice(view, { used: 5, limit: 6 }, 80, false)).toMatchObject({
      title: "80% of this week's videos used",
      message: {
        key: 'videoAllowanceNearing',
        params: { threshold: 80, used: 5, limit: 6, period: 'week' },
      },
    });
    expect(planAllowanceNotice(view, { used: 6, limit: 6 }, 100, true)).toMatchObject({
      title: "All of this week's videos used",
      message: { key: 'videoAllowanceUsed', params: { blocked: 'yes', period: 'week' } },
    });
    expect(planAllowanceNotice(view, { used: 6, limit: 6 }, 100, true).body).toMatch(
      /upgrade your plan or buy a video pack/,
    );
  });
});

describe('23.3 quick posts count as a quarter of a video', () => {
  const starterMonth: Entitlements = {
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    limits: { seats: 1, businesses: 1, storageGb: 100 },
    plan: { id: 'starter', interval: 'month', source: 'stripe' },
  };
  const quick = (id: string, sourceType: string) =>
    row(id, 20, '2026-09-05T00:00:00Z', { sourceType });

  it('shows videos used as a quarter number and percent from the quarters', async () => {
    const rows = [
      row('v1', 20, '2026-09-05T00:00:00Z'),
      quick('c1', 'CAROUSEL'),
      quick('s1', 'SLIDESHOW'),
      quick('w1', 'WALL_OF_TEXT'),
      quick('h1', 'HOOK_DEMO'),
      quick('c2', 'CAROUSEL'),
    ];
    const view = await usageView(
      { db: fakeDb(rows) as never, now: () => SEPT, env: {} },
      'org-1',
      'STANDARD',
      undefined,
      starterMonth,
    );
    // 4 + 5 × 1 = 9 quarters = 2.25 videos of 8 (32 quarters).
    expect(view.videos.short).toMatchObject({
      used: 2.25,
      limit: 8,
      usedQuarters: 9,
      limitQuarters: 32,
      percent: 28,
    });
    expect(view.status).toBe('ok');
  });

  it('fits 32 quick posts in a Starter month and then says the allowance is used', async () => {
    const rows = Array.from({ length: 32 }, (_, i) => quick(`c${i}`, 'CAROUSEL'));
    const view = await usageView(
      { db: fakeDb(rows) as never, now: () => SEPT, env: {} },
      'org-1',
      'STANDARD',
      undefined,
      starterMonth,
    );
    expect(view.videos.short).toMatchObject({ used: 8, limit: 8, percent: 100 });
    expect(view.status).toBe('exceeded');
    const notice = planAllowanceNotice(view, view.videos.short, 100, true);
    expect(notice.body).toMatch(/^8 of 8 videos made this month/);
  });

  it('meter: quarter limits, zero limits and unlimited', () => {
    expect(meter(22, 8, 30)).toMatchObject({ used: 5.5, percent: 69, usedQuarters: 22 });
    expect(meter(1, 0, 30)).toMatchObject({ used: 0.25, percent: 100, limitQuarters: 0 });
    expect(meter(3, null, 30)).toMatchObject({ used: 0.75, percent: null, limitQuarters: null });
  });
});
