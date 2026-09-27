import type { PrismaClient } from '@prisma/client';
import { ConfigurationError } from '../../errors';
import { utcDay } from './job-repository';
import type { BudgetChecker } from './router';

// Budget gates the router applies per candidate (spec 6.4 "skip if provider budget … exhausted",
// 11.4 "Provider budget cap per org per day is a hard ceiling", 12.5 per-project hard cap).
//   1. Project: costActualPence + estimate must stay within video_projects.costBudgetPence.
//   2. Org × provider × UTC day: provider_usage.costPence + estimate within
//      STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE (unset = no cap until tier caps are defined).
// Per-tier caps and the 90% pause/notify rule (12.5) belong to the Phase 3 workers.

export function orgProviderDailyCapFromEnv(): number | undefined {
  const raw = process.env.STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE;
  if (raw === undefined || raw.trim() === '') return undefined;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) {
    throw new ConfigurationError(
      'STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE must be a non-negative integer',
    );
  }
  return cap;
}

type BudgetClient = Pick<PrismaClient, 'videoProject' | 'providerUsage'>;

export function createPrismaBudgetChecker(
  db: BudgetClient,
  options: { orgProviderDailyCapPence?: number; now?: () => number } = {},
): BudgetChecker {
  const now = options.now ?? Date.now;
  return {
    async hasBudget({ organisationId, projectId, providerId, estimatedCostPence }) {
      if (projectId) {
        const project = await db.videoProject.findUnique({
          where: { id: projectId },
          select: { costBudgetPence: true, costActualPence: true },
        });
        if (
          project?.costBudgetPence !== null &&
          project?.costBudgetPence !== undefined &&
          project.costActualPence + estimatedCostPence > project.costBudgetPence
        ) {
          return false;
        }
      }
      const cap = options.orgProviderDailyCapPence;
      if (cap !== undefined) {
        const usage = await db.providerUsage.findUnique({
          where: {
            organisationId_provider_day: {
              organisationId,
              provider: providerId,
              day: utcDay(new Date(now())),
            },
          },
          select: { costPence: true },
        });
        if ((usage?.costPence ?? 0) + estimatedCostPence > cap) return false;
      }
      return true;
    },
  };
}
