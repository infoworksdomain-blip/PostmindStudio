import type { PrismaClient } from '@prisma/client';
import {
  DAILY_THRESHOLDS,
  PLAN_TIERS,
  PROJECT_PAUSE_PERCENT,
  PROJECT_THRESHOLDS,
  percentOf,
  utcDayKey,
  type CostCaps,
} from '../cost/caps';
import { utcDay } from '../providers/job-repository';

// GET /api/studio/admin/cost/caps (spec 12.5 / 16.4): today's spend against every configured cap
// and the recent cost alerts. An organisation's plan tier comes from PostMind Core per request
// and is not stored by Studio, so organisations are listed with today's spend and every tier
// cap is shown; the org-daily alerts say which cap an organisation actually hit.

type Db = Pick<PrismaClient, 'providerUsage' | 'videoProject' | 'costAlert'>;

const TOP_ORGANISATIONS = 50;
const PROJECTS_LIMIT = 50;
const ALERTS_LIMIT = 50;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_ROWS_LIMIT = 5_000;

export async function adminCostCaps(db: Db, caps: CostCaps, now: number) {
  const today = new Date(now);
  const day = utcDay(today);
  const since = new Date(now - RECENT_MS);
  const [usage, projects, alerts] = await Promise.all([
    db.providerUsage.findMany({
      where: { day },
      select: { organisationId: true, provider: true, costPence: true },
      take: USAGE_ROWS_LIMIT,
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

  return {
    day: utcDayKey(today),
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
      orgProviderDaily: providerCap ?? null,
      projectPausePercent: PROJECT_PAUSE_PERCENT,
      projectThresholds: PROJECT_THRESHOLDS,
      dailyThresholds: DAILY_THRESHOLDS,
    },
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
