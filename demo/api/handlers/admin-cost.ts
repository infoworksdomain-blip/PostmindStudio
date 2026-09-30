// /admin/cost and /admin/cost/caps (agent "insight"): cross-organisation provider spend and the
// cost caps (defaults from src/lib/studio/cost/caps.ts, one env override, one disabled).
import { PLAN_CATALOGUE } from '@/lib/studio/billing/catalogue';
import { DEMO_ORG_ID, PROJECTS } from '../ids';
import { DemoHttpError, route } from '../registry';
import { OTHER_ORGS } from './admin-state';
import { capOverrides } from './p13-a3-admin';
import { dayKey, ledger, rollup } from './analytics-cost-data';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

route('GET', '/admin/cost', ({ query }) => {
  const days = Number(query.get('days') ?? 30);
  if (![7, 30, 90].includes(days))
    throw new DemoHttpError(400, 'validation_error', 'days must be 7, 30 or 90');
  const org = query.get('organisationId')?.trim();
  const from = dayKey(days);
  const grouped = new Map<
    string,
    {
      day: string;
      organisationId: string;
      provider: string;
      jobs: number;
      succeeded: number;
      failed: number;
      costPence: number;
    }
  >();
  for (const r of ledger()) {
    if (r.day < from || (org && r.organisationId !== org)) continue;
    const k = `${r.day}|${r.organisationId}|${r.provider}`;
    const cur = grouped.get(k) ?? {
      day: r.day,
      organisationId: r.organisationId,
      provider: r.provider,
      jobs: 0,
      succeeded: 0,
      failed: 0,
      costPence: 0,
    };
    grouped.set(k, {
      ...cur,
      jobs: cur.jobs + r.jobs,
      succeeded: cur.succeeded + r.succeeded,
      failed: cur.failed + r.failed,
      costPence: cur.costPence + r.costPence,
    });
  }
  const data = [...grouped.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.organisationId.localeCompare(b.organisationId) ||
      a.provider.localeCompare(b.provider),
  );
  return { days, data };
});

const ORG_DAILY = {
  BASIC: PLAN_CATALOGUE.BASIC.dailyCostCapPence,
  STANDARD: PLAN_CATALOGUE.STANDARD.dailyCostCapPence,
};
const ORG_MONTHLY = { PLUS: PLAN_CATALOGUE.PLUS.monthlyCostCapPence };
const GLOBAL_DAILY = 250_000;
const ORG_PROVIDER_DAILY = 2_000;
const percentOf = (spent: number, cap: number) =>
  cap > 0 ? Math.floor((spent * 100) / cap) : null;

route('GET', '/admin/cost/caps', () => {
  const now = new Date();
  const today = dayKey(0);
  const month = today.slice(0, 7);
  const all = ledger();
  const todays = all.filter((r) => r.day === today);
  const globalSpent = todays.reduce((t, r) => t + r.costPence, 0);

  const organisations = rollup(todays, (r) => r.organisationId).map((o) => ({
    organisationId: o.key,
    spentPence: o.costPence,
    providers: rollup(
      todays.filter((r) => r.organisationId === o.key),
      (r) => r.provider,
    ).map((p) => ({
      provider: p.key,
      spentPence: p.costPence,
      percentOfCap: percentOf(p.costPence, ORG_PROVIDER_DAILY),
    })),
  }));
  const organisationsThisMonth = rollup(
    all.filter((r) => r.day.startsWith(month)),
    (r) => r.organisationId,
  ).map((o) => ({
    organisationId: o.key,
    spentPence: o.costPence,
  }));

  const spent = (projectId: string) =>
    all.filter((r) => r.projectId === projectId).reduce((t, r) => t + r.costPence, 0);
  const projects = [
    {
      id: PROJECTS.christmas.id,
      name: PROJECTS.christmas.name,
      state: 'FAILED',
      budget: 3_500,
      actual: spent(PROJECTS.christmas.id),
      paused: true,
    },
    {
      id: PROJECTS.loyaltyCard.id,
      name: PROJECTS.loyaltyCard.name,
      state: 'RENDERING',
      budget: 3_200,
      actual: spent(PROJECTS.loyaltyCard.id),
      paused: false,
    },
    {
      id: 'prj-york-yoga-classes',
      name: 'Autumn class timetable',
      state: 'RENDERING',
      budget: 6_000,
      actual: 5_180,
      paused: false,
      org: OTHER_ORGS.york,
    },
  ]
    .map((p) => ({
      id: p.id,
      organisationId: p.org ?? DEMO_ORG_ID,
      name: p.name,
      state: p.state,
      costBudgetPence: p.budget,
      costActualPence: p.actual,
      percent: percentOf(p.actual, p.budget),
      paused: p.paused,
    }))
    .filter((p) => (p.percent ?? 0) >= 80)
    .sort((a, b) => b.costActualPence - a.costActualPence);

  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const dayOf = (ms: number) => at(ms).slice(0, 10);
  const recentAlerts = [
    {
      id: 'ca-1',
      scope: 'ORG_DAILY',
      scopeId: DEMO_ORG_ID,
      organisationId: DEMO_ORG_ID,
      period: today,
      threshold: 80,
      capPence: ORG_DAILY.STANDARD,
      spentPence: 1_230,
      createdAt: at(40 * 60_000),
    },
    {
      id: 'ca-2',
      scope: 'PROJECT',
      scopeId: PROJECTS.christmas.id,
      organisationId: DEMO_ORG_ID,
      period: dayOf(DAY),
      threshold: 90,
      capPence: 3_500,
      spentPence: 3_190,
      createdAt: at(DAY - 2 * HOUR),
    },
    {
      id: 'ca-3',
      scope: 'PROJECT',
      scopeId: PROJECTS.christmas.id,
      organisationId: DEMO_ORG_ID,
      period: dayOf(DAY),
      threshold: 80,
      capPence: 3_500,
      spentPence: 2_860,
      createdAt: at(DAY - HOUR),
    },
    {
      id: 'ca-4',
      scope: 'ORG_MONTHLY',
      scopeId: OTHER_ORGS.york,
      organisationId: OTHER_ORGS.york,
      period: month,
      threshold: 80,
      capPence: ORG_MONTHLY.PLUS,
      spentPence: 21_400,
      createdAt: at(2 * DAY + 5 * HOUR),
    },
    {
      id: 'ca-5',
      scope: 'ORG_PROVIDER_DAILY',
      scopeId: `${OTHER_ORGS.york}:runway`,
      organisationId: OTHER_ORGS.york,
      period: dayOf(3 * DAY),
      threshold: 100,
      capPence: ORG_PROVIDER_DAILY,
      spentPence: 2_040,
      createdAt: at(3 * DAY + 7 * HOUR),
    },
    {
      id: 'ca-6',
      scope: 'ORG_DAILY',
      scopeId: OTHER_ORGS.bramley,
      organisationId: OTHER_ORGS.bramley,
      period: dayOf(4 * DAY),
      threshold: 100,
      capPence: ORG_DAILY.BASIC,
      spentPence: 512,
      createdAt: at(4 * DAY + 2 * HOUR),
    },
  ];

  // 13.19 (track A3): per-organisation overrides set in Admin → Organisations.
  const orgOverrides = [...capOverrides.entries()].map(([organisationId, o]) => ({
    organisationId,
    dailyPence: o.dailyPence,
    monthlyPence: o.monthlyPence,
    source: 'org_override' as const,
    reason: o.reason,
    updatedByUserId: o.updatedByUserId,
    updatedAt: o.updatedAt,
  }));

  return {
    orgOverrides,
    day: today,
    month,
    caps: {
      globalDaily: {
        capPence: GLOBAL_DAILY,
        spentPence: globalSpent,
        percent: percentOf(globalSpent, GLOBAL_DAILY),
      },
      orgDailyByTier: ORG_DAILY,
      orgMonthlyByTier: ORG_MONTHLY,
      orgProviderDaily: ORG_PROVIDER_DAILY,
      sources: {
        globalDaily: 'default',
        orgDailyByTier: {
          BASIC: 'default',
          STANDARD: 'default',
          PLUS: 'env',
          ENTERPRISE: 'default',
        },
        orgMonthlyByTier: {
          BASIC: 'default',
          STANDARD: 'default',
          PLUS: 'default',
          ENTERPRISE: 'disabled',
        },
      },
      projectPausePercent: 90,
      projectThresholds: [80, 90, 100],
      dailyThresholds: [80, 100],
      monthlyThresholds: [80, 100],
    },
    organisationsThisMonth,
    organisations,
    projects,
    recentAlerts,
  };
});
