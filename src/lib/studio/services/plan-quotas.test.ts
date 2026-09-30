import pino from 'pino';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { QuotaExceededError } from '../../errors';
import type { NotificationInput, Notifier } from '../notifications/notifier';
import {
  checkGenerateQuota,
  checkPublishQuota,
  DEFAULT_TIER_QUOTAS,
  generateViolations,
  monthlyVideoUsage,
  notifyQuotaThresholds,
  quotaMode,
  reachedThresholds,
  tierQuota,
  usageView,
  videoKind,
  videoLimitViolations,
} from './plan-quotas';
import { monthWindow } from './tier-gates';

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
    const full = { short: 20, long: 0 };
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
    const usage = await monthlyVideoUsage(
      db as never,
      'org-1',
      DEFAULT_TIER_QUOTAS.STANDARD,
      monthWindow(SEPT),
    );
    expect(usage).toEqual({ short: 1, long: 1 });
    const oct = await monthlyVideoUsage(
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
      videos: { short: { used: 17, limit: 20, percent: 85 }, long: { used: 0, limit: 0 } },
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
