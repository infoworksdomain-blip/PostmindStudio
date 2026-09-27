import type { PrismaClient } from '@prisma/client';
import {
  DAILY_THRESHOLDS,
  MONTHLY_THRESHOLDS,
  PLAN_TIERS,
  PROJECT_PAUSE_PERCENT,
  PROJECT_THRESHOLDS,
  percentOf,
  utcDayKey,
  utcMonthKey,
  utcMonthRange,
  type CapSource,
  type CostCaps,
} from '../cost/caps';
import { utcDay } from '../providers/job-repository';

// GET /api/studio/admin/cost/caps (spec 12.5 / 16.4): today's and this month's spend against
// every configured cap, where each cap value comes from (code default, env override, disabled)
// and the recent cost alerts. An organisation's plan tier comes from PostMind Core per request
// and is not stored by Studio, so organisations are listed with today's spend and every tier
// cap is shown; the org-daily alerts say which cap an organisation actually hit. Organisations
// with a 13.19 override are listed under orgOverrides (source "org_override").

type Db = Pick<PrismaClient, 'providerUsage' | 'videoProject' | 'costAlert' | 'orgCostCap'>;

const TOP_ORGANISATIONS = 50;
const PROJECTS_LIMIT = 50;
const ALERTS_LIMIT = 50;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_ROWS_LIMIT = 5_000;
const OVERRIDES_LIMIT = 200;

export async function adminCostCaps(db: Db, caps: CostCaps, now: number) {
  const today = new Date(now);
  const day = utcDay(today);
  const since = new Date(now - RECENT_MS);
  const month = utcMonthRange(today);
  const [usage, monthly, projects, alerts, overrides] = await Promise.all([
    db.providerUsage.findMany({
      where: { day },
      select: { organisationId: true, provider: true, costPence: true },
      take: USAGE_ROWS_LIMIT,
    }),
    // Month-to-date per organisation (provider_usage(organisationId, day) index), top spenders.
    db.providerUsage.groupBy({
      by: ['organisationId'],
      where: { day: { gte: month.start, lt: month.end } },
      _sum: { costPence: true },
      orderBy: { _sum: { costPence: 'desc' } },
      take: TOP_ORGANISATIONS,
    }),
    // Projects at or above the first alert threshold: costActual * 100 >= budget * 80 cannot be
    // expressed in Prisma, so recent budgeted projects are filtered here (bounded).
    db.videoProject.findMany({
      where: { costBudgetPence: { not: null }, updatedAt: { gte: since }, deletedAt: null },
      select: {
        id: true,
        organisationId: true,
        name: true,
        state: true,
        costBudgetPence: true,
        costActualPence: true,
        errorReason: true,
      },
      orderBy: { costActualPence: 'desc' },
      take: 1_000,
    }),
    db.costAlert.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: ALERTS_LIMIT,
    }),
    // 13.19 per-organisation overrides (source org_override); a short list by nature.
    db.orgCostCap.findMany({ orderBy: { updatedAt: 'desc' }, take: OVERRIDES_LIMIT }),
  ]);

  const orgs = new Map<string, { spentPence: number; providers: Map<string, number> }>();
  let globalSpent = 0;
  for (const row of usage) {
    globalSpent += row.costPence;
    const org = orgs.get(row.organisationId) ?? { spentPence: 0, providers: new Map() };
    org.spentPence += row.costPence;
    org.providers.set(row.provider, (org.providers.get(row.provider) ?? 0) + row.costPence);
    orgs.set(row.organisationId, org);
  }
  const providerCap = caps.orgProviderDailyPence;
  const source = (s: CapSource | undefined): CapSource | 'custom' => s ?? 'custom';

  return {
    day: utcDayKey(today),
    month: utcMonthKey(today),
    caps: {
      globalDaily: {
        capPence: caps.globalDailyPence ?? null,
        spentPence: globalSpent,
        percent:
          caps.globalDailyPence === undefined
            ? null
            : percentOf(globalSpent, caps.globalDailyPence),
      },
      orgDailyByTier: Object.fromEntries(
        PLAN_TIERS.map((tier) => [tier, caps.orgDailyPenceByTier[tier] ?? null]),
      ),
      orgMonthlyByTier: Object.fromEntries(
        PLAN_TIERS.map((tier) => [tier, caps.orgMonthlyPenceByTier?.[tier] ?? null]),
      ),
      orgProviderDaily: providerCap ?? null,
      /** default = operator decision in code, env = STUDIO_* override, disabled = env "none". */
      sources: {
        globalDaily: source(caps.sources?.globalDaily),
        orgDailyByTier: Object.fromEntries(
          PLAN_TIERS.map((tier) => [tier, source(caps.sources?.orgDailyByTier[tier])]),
        ),
        orgMonthlyByTier: Object.fromEntries(
          PLAN_TIERS.map((tier) => [tier, source(caps.sources?.orgMonthlyByTier[tier])]),
        ),
      },
      projectPausePercent: PROJECT_PAUSE_PERCENT,
      projectThresholds: PROJECT_THRESHOLDS,
      dailyThresholds: DAILY_THRESHOLDS,
      monthlyThresholds: MONTHLY_THRESHOLDS,
    },
    organisationsThisMonth: monthly.map((row) => ({
      organisationId: row.organisationId,
      spentPence: row._sum?.costPence ?? 0,
    })),
    /** 13.19: organisations whose daily / monthly cap is overridden (source org_override). */
    orgOverrides: overrides.map((o) => ({
      organisationId: o.organisationId,
      dailyPence: o.dailyPence,
      monthlyPence: o.monthlyPence,
      source: 'org_override' as const,
      reason: o.reason,
      updatedByUserId: o.updatedByUserId,
      updatedAt: o.updatedAt,
    })),
    organisations: [...orgs.entries()]
      .map(([organisationId, o]) => ({
        organisationId,
        spentPence: o.spentPence,
        providers: [...o.providers.entries()]
          .map(([provider, spentPence]) => ({
            provider,
            spentPence,
            percentOfCap: providerCap === undefined ? null : percentOf(spentPence, providerCap),
          }))
          .sort((a, b) => b.spentPence - a.spentPence),
      }))
      .sort((a, b) => b.spentPence - a.spentPence)
      .slice(0, TOP_ORGANISATIONS),
    projects: projects
      .filter(
        (p) =>
          p.costBudgetPence !== null &&
          p.costActualPence * 100 >= p.costBudgetPence * DAILY_THRESHOLDS[0],
      )
      .slice(0, PROJECTS_LIMIT)
      .map((p) => ({
        ...p,
        percent: percentOf(p.costActualPence, p.costBudgetPence ?? 0),
        paused: (p.errorReason ?? '').startsWith('cost_cap_paused'),
      })),
    recentAlerts: alerts.map((a) => ({
      id: a.id,
      scope: a.scope,
      scopeId: a.scopeId,
      organisationId: a.organisationId,
      period: a.period,
      threshold: a.threshold,
      capPence: a.capPence,
      spentPence: a.spentPence,
      createdAt: a.createdAt,
    })),
  };
}
