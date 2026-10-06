import type { Automation, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditEntry } from '../../audit';
import { ConflictError, NotFoundError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { allocateFormats, allowanceVideosFor } from '../blitz/allocate';
import { FORMATS, type FormatKey } from '../blitz/formats';
import { typicalItemCostPence } from '../content-plans/allowance';
import type { ProviderRegistry } from '../providers/registry';
import type { JobQueue } from '../queue/enqueue';
import { downloadOnlyPlatforms } from './automation-items';
import { activate } from './automation-run';
import {
  allowedFormats,
  automationSummary,
  findAutomation,
  isOngoing,
  kickAutomation,
  periodDays,
  postsPerPeriod,
  readCadence,
  cadenceSchema,
  AUTOMATION_DURATIONS,
} from './automations';
import { businessIdParam } from './businesses';
import { PLATFORMS, toPlanTier } from './catalog';
import { getMix } from './content-mix';
import { assertMayScheduleForOwner, cancelPlan } from './content-plan-run';
import { deleteDraftItem, findPlan, publicPlan, regenerateDraftItem } from './content-plans';
import type { PlanGenerator } from './content-plan-draft';

// 22.5 — what the Automations screens do beyond create / start / pause / resume
// (services/automations.ts): the detail with its slot calendar, approving the reviewed period,
// cancelling, the wizard's estimate, and reviewing slots one card at a time ("Review in Blitz
// first": keep, skip = remove, reroll = a new topic for that slot).

export interface ActionDeps {
  db: PrismaClient;
  queue: JobQueue;
  logger: Logger;
  now: () => number;
  registry: ProviderRegistry;
  audit: (entry: AuditEntry) => void;
  env?: Record<string, string | undefined>;
  entitlements?: EntitlementsReader;
}

export async function automationDetail(
  db: PrismaClient,
  organisationId: string,
  id: string,
  env?: Record<string, string | undefined>,
) {
  const automation = await findAutomation(db, organisationId, id);
  const plans = await db.contentPlan.findMany({
    where: { organisationId, automationId: automation.id },
    include: { items: { orderBy: [{ slotAt: 'asc' }, { position: 'asc' }] } },
    orderBy: { windowStart: 'desc' },
    take: 6,
  });
  const reviewed = new Set(
    ((plans[0]?.metadata as { reviewed?: unknown } | null)?.reviewed as string[] | undefined) ?? [],
  );
  return {
    automation: {
      ...automationSummary(automation),
      insight: (automation.metadata as { insight?: unknown } | null)?.insight ?? null,
    },
    periods: plans.map((plan) => {
      const view = publicPlan(plan);
      return {
        ...view,
        items: view.items.map((item, i) => ({
          ...item,
          format: plan.items[i]?.format ?? null,
          angleId: plan.items[i]?.angleId ?? null,
          reviewed: reviewed.has(item.id),
          downloadOnly: downloadOnlyPlatforms(plan.items[i]?.format, plan.platforms, env),
        })),
      };
    }),
  };
}

/** POST /automations/:id/approve — the owner approves the reviewed period (REVIEW → ACTIVE). */
export async function approveReview(deps: ActionDeps, tenant: TenantContext, id: string) {
  assertMayScheduleForOwner(tenant);
  const automation = await findAutomation(deps.db, tenant.organisationId, id);
  if (automation.status !== 'REVIEW')
    throw new ConflictError(`The automation is ${automation.status}`, {
      status: automation.status,
    });
  const plan = await deps.db.contentPlan.findFirst({
    where: { id: automation.currentPlanId ?? '', organisationId: tenant.organisationId },
  });
  if (!plan) throw new NotFoundError('The period plan is missing');
  const outcome = await activate(deps, automation, tenant, plan);
  if (outcome !== 'activated')
    throw new ConflictError('Another plan is still generating; try again in a few minutes', {
      code: 'busy',
    });
  return findAutomation(deps.db, tenant.organisationId, id);
}

/** POST /automations/:id/cancel — every post not yet out is cancelled; the automation ends. */
export async function cancelAutomation(
  deps: ActionDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'capabilities'>,
  id: string,
): Promise<Automation> {
  const automation = await findAutomation(deps.db, tenant.organisationId, id);
  if (automation.status === 'CANCELLED' || automation.status === 'COMPLETED')
    throw new ConflictError(`The automation is ${automation.status}`, {
      status: automation.status,
    });
  const open = await deps.db.contentPlan.findMany({
    where: {
      organisationId: tenant.organisationId,
      automationId: automation.id,
      status: { in: ['DRAFTING', 'DRAFT', 'GENERATING', 'SCHEDULED'] },
    },
    select: { id: true },
  });
  for (const plan of open) {
    try {
      await cancelPlan(deps, tenant, plan.id);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  return deps.db.automation.update({
    where: { id: automation.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(deps.now()) },
  });
}

// ------------------------------------------------------------------ the wizard's estimate

export const estimateInput = z
  .object({
    businessId: businessIdParam,
    cadence: cadenceSchema,
    duration: z.enum(AUTOMATION_DURATIONS),
    platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
  })
  .strict();

/**
 * Posts per period and the format split the business's mix gives (cheapest first). The pence
 * estimate is for staff only (the route strips it for customers, `useShowCosts` on the page).
 */
export async function estimateAutomation(
  deps: Pick<ActionDeps, 'db' | 'env'>,
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  input: z.infer<typeof estimateInput>,
) {
  const mix = await getMix(deps.db, {
    organisationId: tenant.organisationId,
    businessId: input.businessId,
  });
  const posts = Math.round(postsPerPeriod(input.cadence, input.duration));
  const formats = allocateFormats(
    posts,
    mix,
    await allowedFormats(
      deps.db,
      {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        platforms: input.platforms,
        language: 'en-GB',
      },
      mix,
      deps.env,
    ),
  );
  const split: Partial<Record<FormatKey, number>> = {};
  for (const f of formats) split[f] = (split[f] ?? 0) + 1;
  const tier = toPlanTier(tenant.organisation.planTier);
  return {
    posts,
    periodDays: periodDays(input.duration),
    ongoing: isOngoing(input.duration),
    split,
    paidPosts: formats.filter((f) => FORMATS[f].tier === 'preview').length,
    // 23.3: videos of the allowance (a quarter number: quick posts use ¼).
    allowanceUnits: allowanceVideosFor(formats),
    estimatePence: formats.reduce(
      (sum, f) => sum + typicalItemCostPence(FORMATS[f].planKind ?? 'VIDEO', tier),
      0,
    ),
  };
}

// ------------------------------------------------------------------ slot review (Blitz)

export const slotDecisionInput = z.object({ action: z.enum(['keep', 'skip', 'reroll']) }).strict();

/** One slot of a period in REVIEW: keep it, take it out, or have it rewritten. */
export async function decideSlot(
  deps: ActionDeps & { generate: PlanGenerator },
  organisationId: string,
  automationId: string,
  itemId: string,
  action: z.infer<typeof slotDecisionInput>['action'],
) {
  const automation = await findAutomation(deps.db, organisationId, automationId);
  if (automation.status !== 'REVIEW' || !automation.currentPlanId)
    throw new ConflictError('Only a period waiting for review can be reviewed', {
      status: automation.status,
    });
  const plan = await findPlan(deps.db, organisationId, automation.currentPlanId);
  if (!plan.items.some((i) => i.id === itemId)) throw new NotFoundError('Slot not found');
  if (action === 'skip') await deleteDraftItem(deps.db, plan, itemId);
  if (action === 'reroll') await regenerateDraftItem(deps, plan, itemId);
  if (action !== 'skip') {
    const reviewed = new Set(
      ((plan.metadata as { reviewed?: unknown } | null)?.reviewed as string[] | undefined) ?? [],
    );
    reviewed.add(itemId);
    const fresh = await deps.db.contentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    await deps.db.contentPlan.update({
      where: { id: plan.id },
      data: {
        metadata: {
          ...((fresh.metadata as Record<string, unknown> | null) ?? {}),
          reviewed: [...reviewed],
        } as Prisma.InputJsonValue,
      },
    });
  }
  await kickAutomation(deps.queue, automation.id, deps.now()).catch(() => undefined);
  return automationDetail(deps.db, organisationId, automationId, deps.env);
}

export { readCadence };
