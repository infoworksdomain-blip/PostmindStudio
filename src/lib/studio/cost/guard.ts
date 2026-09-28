import type { CostAlertScope, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { CostCapPausedError } from '../../errors';
import type { StudioMetrics } from '../observability/metrics';
import type { Notifier, NotificationKind, NotificationMessage } from '../notifications/notifier';
import { utcDay } from '../providers/job-repository';
import type { PlanTier } from '../providers/router';
import {
  crossedThresholds,
  DAILY_THRESHOLDS,
  MONTHLY_THRESHOLDS,
  PROJECT_PAUSE_PERCENT,
  PROJECT_THRESHOLDS,
  utcDayKey,
  utcMonthKey,
  utcMonthRange,
  type CostCaps,
} from './caps';
import { formatGbp } from './format';
import type { OrgCapOverrideLookup } from './org-overrides';

// Spec 12.5 cost caps and alerting, spec 11.4 "on exhaustion, jobs pause and a notification is
// sent", risk register "alerting at 80% / 100%; automated pause".
//   assertNotPaused — before routing any provider call: throws CostCapPausedError when
//     · the project has spent ≥ 90% of costBudgetPence, or
//     · the organisation's daily total (all providers) has reached its plan tier's cap, or
//     · the organisation's calendar-month (UTC) total has reached its tier's monthly cap, or
//     · the platform's daily total has reached STUDIO_GLOBAL_DAILY_CAP_PENCE.
//   recordSpend — after spend is reserved or settled: raises the alerts it crossed.
// Both raise alerts, so a threshold crossed by the last call before a quiet period is still
// reported, and a pause always has its alert. Each (scope, scopeId, period, threshold) alerts
// exactly once (studio.cost_alerts unique key), fanned out to a metric, an audit event, a warn
// log and a notification (project/org → the organisation; global → PostMind staff).
// Publishing never calls a provider, so no cap ever stops an already-generated video going out.

export interface SpendScope {
  organisationId: string;
  projectId?: string;
  planTier: PlanTier;
}

export interface CapUsage {
  scope: CostAlertScope;
  scopeId: string;
  organisationId: string | null;
  period: string;
  capPence: number;
  spentPence: number;
  thresholds: readonly number[];
  project?: { id: string; name: string; createdByUserId: string };
  provider?: string;
}

export interface CostGuard {
  assertNotPaused(scope: SpendScope): Promise<void>;
  recordSpend(scope: SpendScope & { providerId: string }): Promise<void>;
  /** Current spend against every cap that applies (admin report, tests). */
  usage(scope: SpendScope & { providerId?: string }): Promise<CapUsage[]>;
}

type GuardClient = Pick<PrismaClient, 'videoProject' | 'providerUsage' | 'costAlert'>;

export interface CostGuardDeps {
  db: GuardClient;
  caps: CostCaps;
  notifier: Notifier;
  audit: (entry: AuditEntry) => void;
  logger: Logger;
  metrics: Pick<StudioMetrics, 'costAlerts'>;
  now?: () => number;
  /** 13.19 per-organisation overrides of the daily / monthly caps (cost/org-overrides.ts). */
  overrides?: OrgCapOverrideLookup;
}

export const COST_ACTOR = 'system:studio-cost-guard';
/** Audit organisation for platform-wide (global cap) events. */
export const PLATFORM_ORGANISATION = 'postmind-platform';
const FIRED_CACHE_MAX = 10_000;

const SCOPE_LABEL: Record<CostAlertScope, string> = {
  PROJECT: 'project',
  ORG_DAILY: 'org_daily',
  ORG_MONTHLY: 'org_monthly',
  ORG_PROVIDER_DAILY: 'org_provider_daily',
  GLOBAL_DAILY: 'global_daily',
};

function pausesAt(usage: CapUsage): number {
  return usage.scope === 'PROJECT' ? PROJECT_PAUSE_PERCENT : 100;
}

/** Generation is paused by this cap (org-provider caps only skip that provider). */
export function isPaused(usage: CapUsage): boolean {
  if (usage.scope === 'ORG_PROVIDER_DAILY') return false;
  return usage.spentPence * 100 >= usage.capPence * pausesAt(usage);
}

interface Message {
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
  /** 16.5: rendered in the reader's locale (notifications.cost*). */
  message?: NotificationMessage;
}

/**
 * ICU parameters shared by every cost message. Money is in pounds (the catalogue formats it with
 * `{spent, number, ::currency/GBP}`); `threshold` / `pausePercent` are whole percentages.
 */
function costParams(usage: CapUsage, threshold: number): Record<string, number> {
  return { spent: usage.spentPence / 100, cap: usage.capPence / 100, threshold };
}

export function alertMessage(usage: CapUsage, threshold: number): Message {
  const spent = `${formatGbp(usage.spentPence)} of ${formatGbp(usage.capPence)}`;
  const pause = threshold >= pausesAt(usage) && usage.scope !== 'ORG_PROVIDER_DAILY';
  const params = costParams(usage, threshold);
  switch (usage.scope) {
    case 'PROJECT': {
      const name = usage.project?.name ?? 'A project';
      const link = usage.project ? `/projects/${usage.project.id}` : undefined;
      // Without a project row there is no name to show: the stored English text is used.
      const keyed = (key: NotificationMessage['key']) =>
        usage.project
          ? {
              message: {
                key,
                params: { ...params, name, pausePercent: PROJECT_PAUSE_PERCENT },
              },
            }
          : {};
      if (threshold === PROJECT_PAUSE_PERCENT)
        return {
          kind: 'cost_paused',
          title: `Generation paused: “${name}” reached 90% of its budget`,
          body: `${spent} spent. Open the project, raise its budget (Raise budget), then press Generate again.`,
          link,
          ...keyed('costProjectPaused'),
        };
      const under = threshold < PROJECT_PAUSE_PERCENT;
      return {
        kind: 'cost_alert',
        title: `“${name}” has used ${threshold}% of its budget`,
        body: under
          ? `${spent} spent. Generation pauses at 90% of the budget; it can then be raised on the project page.`
          : `${spent} spent. Generation is paused until the budget is raised.`,
        link,
        ...keyed(under ? 'costProjectAlert' : 'costProjectOverBudget'),
      };
    }
    case 'ORG_DAILY':
      return {
        kind: pause ? 'cost_paused' : 'cost_alert',
        title: pause
          ? 'Generation paused: today’s generation budget is spent'
          : `${threshold}% of today’s generation budget used`,
        body: pause
          ? `${spent} spent today (UTC). New generation resumes after midnight UTC; publishing is not affected.`
          : `${spent} spent today (UTC). Generation pauses at 100% until midnight UTC; publishing is not affected.`,
        link: '/analytics',
        message: { key: pause ? 'costDailyPaused' : 'costDailyAlert', params },
      };
    case 'ORG_MONTHLY':
      return {
        kind: pause ? 'cost_paused' : 'cost_alert',
        title: pause
          ? 'Generation paused: this month’s generation budget is spent'
          : `${threshold}% of this month’s generation budget used`,
        body: pause
          ? `${spent} spent this month (UTC). New generation resumes on the 1st (UTC) or when your plan's monthly cap is raised; publishing is not affected.`
          : `${spent} spent this month (UTC). Generation pauses at 100% until the 1st (UTC); publishing is not affected.`,
        link: '/analytics',
        message: { key: pause ? 'costMonthlyPaused' : 'costMonthlyAlert', params },
      };
    case 'ORG_PROVIDER_DAILY':
      return {
        kind: 'cost_alert',
        title: `${threshold}% of today’s ${usage.provider ?? 'provider'} budget used`,
        body: `${spent} spent today (UTC) with ${usage.provider ?? 'this provider'}. At 100% Studio routes to fallback providers where they exist.`,
        link: '/analytics',
        ...(usage.provider && {
          message: { key: 'costProviderDaily', params: { ...params, provider: usage.provider } },
        }),
      };
    case 'GLOBAL_DAILY':
      return {
        kind: pause ? 'cost_paused' : 'cost_alert',
        title: pause
          ? 'Global daily provider cap reached: all generation paused'
          : `Global daily provider spend at ${threshold}% of the cap`,
        body: `${spent} spent today (UTC) across all organisations (STUDIO_GLOBAL_DAILY_CAP_PENCE). See runbooks/cost-runaway.md.`,
        link: '/admin',
        message: { key: pause ? 'costGlobalPaused' : 'costGlobalAlert', params },
      };
  }
}

function alertKey(u: CapUsage, threshold: number): string {
  return `${u.scope}|${u.scopeId}|${u.period}|${threshold}`;
}

export function createCostGuard(deps: CostGuardDeps): CostGuard {
  const now = deps.now ?? Date.now;
  /** Alerts this process already raised (or saw as raised): skips repeat inserts. */
  const fired = new Set<string>();

  async function projectUsage(projectId: string): Promise<CapUsage | undefined> {
    const project = await deps.db.videoProject.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        organisationId: true,
        createdByUserId: true,
        costBudgetPence: true,
        costActualPence: true,
      },
    });
    if (!project || project.costBudgetPence === null) return undefined;
    return {
      scope: 'PROJECT',
      scopeId: project.id,
      organisationId: project.organisationId,
      period: `budget:${project.costBudgetPence}`,
      capPence: project.costBudgetPence,
      spentPence: project.costActualPence,
      thresholds: PROJECT_THRESHOLDS,
      project: { id: project.id, name: project.name, createdByUserId: project.createdByUserId },
    };
  }

  async function usage(scope: SpendScope & { providerId?: string }): Promise<CapUsage[]> {
    const today = new Date(now());
    const day = utcDay(today);
    const period = utcDayKey(today);
    const out: CapUsage[] = [];
    if (scope.projectId) {
      const project = await projectUsage(scope.projectId);
      if (project) out.push(project);
    }
    // 13.19: organisation override > env > default (cost/org-overrides.ts).
    const override = (await deps.overrides?.(scope.organisationId)) ?? null;
    const orgCap = override?.dailyPence ?? deps.caps.orgDailyPenceByTier[scope.planTier];
    if (orgCap !== undefined) {
      const sum = await deps.db.providerUsage.aggregate({
        where: { organisationId: scope.organisationId, day },
        _sum: { costPence: true },
      });
      out.push({
        scope: 'ORG_DAILY',
        scopeId: scope.organisationId,
        organisationId: scope.organisationId,
        period,
        capPence: orgCap,
        spentPence: sum._sum.costPence ?? 0,
        thresholds: DAILY_THRESHOLDS,
      });
    }
    const monthlyCap = override?.monthlyPence ?? deps.caps.orgMonthlyPenceByTier?.[scope.planTier];
    if (monthlyCap !== undefined) {
      // Served by the provider_usage(organisationId, day) index: one org, one month of days.
      const { start, end } = utcMonthRange(today);
      const sum = await deps.db.providerUsage.aggregate({
        where: { organisationId: scope.organisationId, day: { gte: start, lt: end } },
        _sum: { costPence: true },
      });
      out.push({
        scope: 'ORG_MONTHLY',
        scopeId: scope.organisationId,
        organisationId: scope.organisationId,
        period: utcMonthKey(today),
        capPence: monthlyCap,
        spentPence: sum._sum.costPence ?? 0,
        thresholds: MONTHLY_THRESHOLDS,
      });
    }
    const providerCap = deps.caps.orgProviderDailyPence;
    if (providerCap !== undefined && scope.providerId) {
      const row = await deps.db.providerUsage.findUnique({
        where: {
          organisationId_provider_day: {
            organisationId: scope.organisationId,
            provider: scope.providerId,
            day,
          },
        },
        select: { costPence: true },
      });
      out.push({
        scope: 'ORG_PROVIDER_DAILY',
        scopeId: `${scope.organisationId}/${scope.providerId}`,
        organisationId: scope.organisationId,
        period,
        capPence: providerCap,
        spentPence: row?.costPence ?? 0,
        thresholds: DAILY_THRESHOLDS,
        provider: scope.providerId,
      });
    }
    const globalCap = deps.caps.globalDailyPence;
    if (globalCap !== undefined) {
      const sum = await deps.db.providerUsage.aggregate({
        where: { day },
        _sum: { costPence: true },
      });
      out.push({
        scope: 'GLOBAL_DAILY',
        scopeId: 'global',
        organisationId: null,
        period,
        capPence: globalCap,
        spentPence: sum._sum.costPence ?? 0,
        thresholds: DAILY_THRESHOLDS,
      });
    }
    return out;
  }

  async function fanOut(u: CapUsage, threshold: number, alertId: string): Promise<void> {
    const scopeLabel = SCOPE_LABEL[u.scope];
    deps.metrics.costAlerts.inc({ scope: scopeLabel, threshold: String(threshold) });
    const details = {
      scope: scopeLabel,
      scopeId: u.scopeId,
      period: u.period,
      threshold,
      capPence: u.capPence,
      spentPence: u.spentPence,
      paused: isPaused(u) && threshold >= pausesAt(u),
    };
    deps.audit({
      actorUserId: COST_ACTOR,
      organisationId: u.organisationId ?? PLATFORM_ORGANISATION,
      action: 'studio.cost.alert',
      resource: { type: 'cost_alert', id: alertId },
      metadata: details,
    });
    deps.logger.warn(
      { ...details, organisationId: u.organisationId, projectId: u.project?.id },
      'cost alert',
    );
    const message = alertMessage(u, threshold);
    const dedupeKey = `cost:${alertKey(u, threshold)}`;
    if (u.scope === 'GLOBAL_DAILY') {
      await deps.notifier.notifyStaff({ ...message, dedupeKey });
    } else if (u.organisationId) {
      await deps.notifier.notify({
        ...message,
        organisationId: u.organisationId,
        userId: u.project?.createdByUserId ?? null,
        dedupeKey,
      });
    }
  }

  async function raiseAlerts(usages: CapUsage[]): Promise<void> {
    for (const u of usages) {
      for (const threshold of crossedThresholds(u.spentPence, u.capPence, u.thresholds)) {
        const key = alertKey(u, threshold);
        if (fired.has(key)) continue;
        // createMany + skipDuplicates = INSERT … ON CONFLICT DO NOTHING: exactly one caller wins.
        const inserted = await deps.db.costAlert.createManyAndReturn({
          data: [
            {
              scope: u.scope,
              scopeId: u.scopeId,
              organisationId: u.organisationId,
              period: u.period,
              threshold,
              capPence: u.capPence,
              spentPence: u.spentPence,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        });
        if (fired.size >= FIRED_CACHE_MAX) fired.clear();
        fired.add(key);
        const alert = inserted[0];
        if (alert) await fanOut(u, threshold, alert.id);
      }
    }
  }

  /** Alerting must never break generation: failures are logged. */
  async function raiseSafely(usages: CapUsage[]): Promise<void> {
    try {
      await raiseAlerts(usages);
    } catch (err) {
      deps.logger.error({ err }, 'cost alerting failed');
    }
  }

  return {
    usage,
    async assertNotPaused(scope) {
      const usages = await usage(scope);
      await raiseSafely(usages);
      const paused = usages.find(isPaused);
      if (!paused) return;
      const spent = `${formatGbp(paused.spentPence)} of ${formatGbp(paused.capPence)}`;
      if (paused.scope === 'PROJECT') {
        throw new CostCapPausedError(
          'project',
          `project reached ${PROJECT_PAUSE_PERCENT}% of its budget (${spent}). Raise the budget on the project page (or PATCH costBudgetPence), then generate again`,
          { spentPence: paused.spentPence, capPence: paused.capPence },
        );
      }
      if (paused.scope === 'ORG_MONTHLY') {
        throw new CostCapPausedError(
          'org_monthly',
          `organisation monthly cost cap reached (${spent} this month, ${scope.planTier} tier); generation resumes on the 1st (UTC)`,
          { spentPence: paused.spentPence, capPence: paused.capPence },
        );
      }
      throw new CostCapPausedError(
        paused.scope === 'ORG_DAILY' ? 'org_daily' : 'global_daily',
        paused.scope === 'ORG_DAILY'
          ? `organisation daily cost cap reached (${spent} today, ${scope.planTier} tier); generation resumes after midnight UTC`
          : `global daily cost cap reached (${spent} today); generation is paused platform-wide`,
        { spentPence: paused.spentPence, capPence: paused.capPence },
      );
    },
    async recordSpend(scope) {
      try {
        await raiseAlerts(await usage(scope));
      } catch (err) {
        deps.logger.error({ err }, 'cost alerting failed');
      }
    },
  };
}
