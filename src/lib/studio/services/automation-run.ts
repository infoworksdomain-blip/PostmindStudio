import type { Automation, ContentPlan, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { RateLimitError } from '../../errors';
import { capabilitiesForRole } from '../../identity/role-capabilities';
import type { TenantContext } from '../../tenant';
import type { BillingAccessLookup } from '../billing/job-access';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { fingerprintOf, isNearDuplicate } from '../blitz/fingerprint';
import { isFormatKey } from '../blitz/formats';
import type { KillSwitch } from '../kill-switch';
import { loadPlanAllowance } from '../content-plans/allowance';
import { notifySafely, type Notifier } from '../notifications/notifier';
import type { JobQueue } from '../queue/enqueue';
import { recentFingerprints } from './blitz-refill';
import { generatePlan } from './content-plan-run';
import { loadPlanContext, writeTopics, type PlanGenerator } from './content-plan-draft';
import { getMix, recordSignal } from './content-mix';
import {
  AUTOMATION_PERIOD_LEAD_DAYS,
  draftPeriod,
  isOngoing,
  nextPeriodStart,
  pauseAutomation,
} from './automations';
import { toPlanTier } from './catalog';

// 22.5 — the automation runner (advance-automations, every 5 minutes and kicked after a change;
// platform-level like the month-plan runner, each automation's own kill switch checked):
//   GENERATING: the period's posts are being written (draft-content-plan). Once the plan is a
//               DRAFT, near-duplicates of the last 90 days are rewritten once and dropped if they
//               still repeat (no_unique_content); then "auto" approves the plan (generatePlan as
//               the person who started the automation) → ACTIVE, and "review" → REVIEW with a
//               notification.
//   REVIEW:     waits for "Approve and schedule" (or the plan generated from its own page).
//   ACTIVE:     the month-plan runner generates and posts; an ongoing automation drafts the next
//               period AUTOMATION_PERIOD_LEAD_DAYS before this one ends — unless billing access is
//               not full, the allowance is used up (PAUSED + notification with the upgrade / pack
//               prompt) or the person who started it left; a one-off one COMPLETES with its plan.
//   Weekly:     an insight ("your top post — make more like this") for ACTIVE automations.

const DAY_MS = 86_400_000;
const BATCH = 50;
export const AUTOMATION_RUNNER_SCHEDULE = '*/5 * * * *';
export const INSIGHT_EVERY_DAYS = 7;

export interface AutomationRunDeps {
  db: PrismaClient;
  queue: JobQueue;
  logger: Logger;
  now: () => number;
  killSwitch: Pick<KillSwitch, 'check'>;
  /** The Claude call for rewriting duplicates (per organisation). */
  generator: (organisationId: string, planTier: string) => PlanGenerator;
  billingAccess?: BillingAccessLookup;
  entitlements?: EntitlementsReader;
  notifier?: Notifier;
  audit: (entry: AuditEntry) => void;
  env?: Record<string, string | undefined>;
}

export interface AutomationRunResult {
  automations: number;
  activated: number;
  review: number;
  rolledOver: number;
  paused: number;
  completed: number;
}

export const AUTOMATION_ACTOR = 'system:automation';

/**
 * The person who started the automation, as a tenant: their current organisation role's
 * capabilities (standalone; a member who left → null), or the snapshot taken when they started it
 * (core mode, where Core owns memberships).
 */
export async function ownerTenant(
  db: Pick<PrismaClient, 'member'>,
  automation: Automation,
): Promise<TenantContext | null> {
  const organisation = {
    id: automation.organisationId,
    planTier: automation.planTier ?? undefined,
  };
  const anyMember = await db.member.findFirst({
    where: { organizationId: automation.organisationId },
    select: { id: true },
  });
  let capabilities = automation.capabilities;
  if (anyMember) {
    const member = await db.member.findFirst({
      where: { organizationId: automation.organisationId, userId: automation.createdByUserId },
      select: { role: true },
    });
    if (!member) return null;
    capabilities = capabilitiesForRole(member.role);
  }
  return {
    userId: automation.createdByUserId,
    organisationId: automation.organisationId,
    organisation,
    memberships: [],
    capabilities,
  };
}

function audit(
  deps: AutomationRunDeps,
  a: Automation,
  action: string,
  metadata?: Record<string, unknown>,
) {
  deps.audit({
    actorUserId: AUTOMATION_ACTOR,
    organisationId: a.organisationId,
    action,
    resource: { type: 'automation', id: a.id },
    metadata: { businessId: a.businessId, ...metadata },
  });
}

async function notify(
  deps: AutomationRunDeps,
  a: Automation,
  key: 'automationReview' | 'automationPaused' | 'automationInsight',
  params: Record<string, string | number>,
  dedupeKey: string,
  link = `/automations/${a.id}`,
) {
  const english: Record<typeof key, { title: string; body: string }> = {
    automationReview: {
      title: `“${a.name}” is ready to review`,
      body: 'Keep, swap or edit the posts, then approve them to schedule the period.',
    },
    automationPaused: {
      title: `“${a.name}” is paused`,
      body: 'It stopped making new posts. Open it to see why and to resume.',
    },
    automationInsight: {
      title: `Your top post this week: ${String(params.title ?? '')}`,
      body: 'Make more like this to see more of its format and angle.',
    },
  };
  await notifySafely(
    { db: deps.db, logger: deps.logger, notifier: deps.notifier },
    {
      organisationId: a.organisationId,
      userId: a.createdByUserId,
      kind:
        key === 'automationInsight'
          ? 'milestone'
          : key === 'automationPaused'
            ? 'plan_quota'
            : 'approval_pending',
      title: english[key].title,
      body: english[key].body,
      link,
      dedupeKey,
      message: { key, params: { name: a.name, ...params } },
    },
  );
}

// ------------------------------------------------------------------ duplicates

/**
 * no_unique_content: every written slot is fingerprinted; a near-duplicate of the business's last
 * 90 days (or of an earlier slot of the period) is rewritten once, then skipped if it still
 * repeats. Runs once per plan (metadata.deduped).
 */
export async function dedupePlan(
  deps: Pick<AutomationRunDeps, 'db' | 'now'> & { generate: PlanGenerator },
  plan: ContentPlan,
): Promise<{ rewritten: number; skipped: number }> {
  const scope = { organisationId: plan.organisationId, businessId: plan.businessId };
  const items = await deps.db.contentPlanItem.findMany({
    where: { planId: plan.id, status: 'PLANNED' },
    orderBy: [{ slotAt: 'asc' }, { position: 'asc' }],
  });
  const ids = new Set(items.map((i) => i.id));
  const earlier = (await recentFingerprints(deps.db, scope, deps.now())).filter(Boolean);
  // The plan's own items are in recentFingerprints too (created now): check against the rest.
  const own = await deps.db.contentPlanItem.findMany({
    where: { planId: plan.id },
    select: { id: true, title: true, slides: true },
  });
  const ownPrints = new Set(
    own.map((i) => fingerprintOf(i.title, (i.slides as { hook?: string } | null)?.hook ?? null)),
  );
  const history = earlier.filter((f) => !ownPrints.has(f));
  const seen = [...history];
  const result = { rewritten: 0, skipped: 0 };
  const hookOf = (slides: Prisma.JsonValue | null) =>
    (slides as { hook?: string } | null)?.hook ?? null;
  for (const item of items) {
    let print = fingerprintOf(item.title, hookOf(item.slides));
    if (isNearDuplicate(print, seen)) {
      const context = await loadPlanContext(deps.db, plan, deps.now());
      await writeTopics(deps, plan, [item], context, [...own.map((o) => o.title)]);
      const fresh = await deps.db.contentPlanItem.findUnique({ where: { id: item.id } });
      print = fresh ? fingerprintOf(fresh.title, hookOf(fresh.slides)) : print;
      result.rewritten += 1;
      if (isNearDuplicate(print, seen)) {
        await deps.db.contentPlanItem.update({
          where: { id: item.id },
          data: { status: 'SKIPPED', statusReason: 'no_unique_content', fingerprint: print },
        });
        result.skipped += 1;
        continue;
      }
    }
    seen.push(print);
    if (ids.has(item.id))
      await deps.db.contentPlanItem.update({
        where: { id: item.id },
        data: { fingerprint: print },
      });
  }
  await deps.db.contentPlan.update({
    where: { id: plan.id },
    data: {
      metadata: {
        ...((plan.metadata as Record<string, unknown> | null) ?? {}),
        deduped: true,
      } as Prisma.InputJsonValue,
    },
  });
  return result;
}

// ------------------------------------------------------------------ the runner

export async function advanceAutomations(
  deps: AutomationRunDeps,
  filter: { automationId?: string } = {},
): Promise<AutomationRunResult> {
  const rows = await deps.db.automation.findMany({
    where: {
      status: { in: ['GENERATING', 'REVIEW', 'ACTIVE'] },
      ...(filter.automationId && { id: filter.automationId }),
    },
    orderBy: { updatedAt: 'asc' },
    take: BATCH,
  });
  const result: AutomationRunResult = {
    automations: rows.length,
    activated: 0,
    review: 0,
    rolledOver: 0,
    paused: 0,
    completed: 0,
  };
  for (const a of rows) {
    try {
      const outcome = await advanceOne(deps, a);
      if (outcome) result[outcome] += 1;
    } catch (err) {
      deps.logger.error(
        { err, automationId: a.id, organisationId: a.organisationId },
        'automation could not advance',
      );
    }
  }
  return result;
}

type Outcome = Exclude<keyof AutomationRunResult, 'automations'> | null;

async function pause(deps: AutomationRunDeps, a: Automation, reason: string): Promise<Outcome> {
  await pauseAutomation(deps, a.organisationId, a.id, reason);
  audit(deps, a, 'studio.automation.pause', { reason });
  await notify(
    deps,
    a,
    'automationPaused',
    { reason },
    `automation-paused:${a.id}:${a.periodIndex}:${reason}`,
  );
  return 'paused';
}

async function advanceOne(deps: AutomationRunDeps, a: Automation): Promise<Outcome> {
  const log = deps.logger.child({ automationId: a.id, organisationId: a.organisationId });
  if ((await deps.killSwitch.check({ organisationId: a.organisationId })).killed) return null;
  const owner = await ownerTenant(deps.db, a);
  if (!owner) return pause(deps, a, 'owner_left');
  const plan = a.currentPlanId
    ? await deps.db.contentPlan.findFirst({
        where: { id: a.currentPlanId, organisationId: a.organisationId },
      })
    : null;
  if (!plan) return pause(deps, a, 'plan_missing');
  if (plan.status === 'CANCELLED') {
    await deps.db.automation.update({
      where: { id: a.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(deps.now()) },
    });
    return 'completed';
  }

  if (a.status === 'GENERATING') {
    if (plan.status === 'DRAFTING') return null;
    if (plan.status === 'DRAFT') {
      if ((plan.metadata as { deduped?: unknown } | null)?.deduped !== true) {
        const generate = deps.generator(a.organisationId, a.planTier ?? 'STANDARD');
        const dupes = await dedupePlan({ db: deps.db, now: deps.now, generate }, plan);
        if (dupes.skipped) log.info(dupes, 'automation slots dropped as duplicates');
      }
      if (a.approvalMode === 'auto') return activate(deps, a, owner, plan);
      await deps.db.automation.update({ where: { id: a.id }, data: { status: 'REVIEW' } });
      await notify(deps, a, 'automationReview', {}, `automation-review:${a.id}:${plan.id}`);
      return 'review';
    }
    // The owner generated the plan from its own page.
    await deps.db.automation.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    return 'activated';
  }

  if (a.status === 'REVIEW') {
    if (plan.status === 'GENERATING' || plan.status === 'SCHEDULED') {
      await deps.db.automation.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
      return 'activated';
    }
    return null;
  }

  // ACTIVE
  await maybeInsight(deps, a);
  if (!isOngoing(a.duration)) {
    if (plan.status === 'COMPLETED') {
      await deps.db.automation.update({
        where: { id: a.id },
        data: { status: 'COMPLETED', completedAt: new Date(deps.now()) },
      });
      audit(deps, a, 'studio.automation.complete');
      return 'completed';
    }
    return null;
  }
  if (plan.windowEnd.getTime() - AUTOMATION_PERIOD_LEAD_DAYS * DAY_MS > deps.now()) return null;
  return rollOver(deps, a, plan);
}

/** Approve the period's plan as the owner (generatePlan) → ACTIVE. */
export async function activate(
  deps: Pick<
    AutomationRunDeps,
    'db' | 'queue' | 'logger' | 'now' | 'audit' | 'entitlements' | 'env'
  >,
  a: Automation,
  owner: TenantContext,
  plan: ContentPlan,
): Promise<Outcome> {
  try {
    await generatePlan(
      {
        db: deps.db,
        queue: deps.queue,
        logger: deps.logger,
        now: deps.now,
        env: deps.env,
        entitlements: deps.entitlements,
      },
      owner,
      plan.id,
    );
  } catch (err) {
    // Too many plans generating at once: the next run tries again.
    if (err instanceof RateLimitError) return null;
    throw err;
  }
  await deps.db.automation.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
  deps.audit({
    actorUserId: owner.userId,
    organisationId: a.organisationId,
    action: 'studio.automation.activate',
    resource: { type: 'automation', id: a.id },
    metadata: { planId: plan.id, period: a.periodIndex, approvalMode: a.approvalMode },
  });
  return 'activated';
}

async function rollOver(
  deps: AutomationRunDeps,
  a: Automation,
  plan: ContentPlan,
): Promise<Outcome> {
  // Stops when the subscription is cancelled / read-only (billing access not full).
  if (deps.billingAccess && (await deps.billingAccess(a.organisationId)) !== 'full')
    return pause(deps, a, 'billing');
  const tier = toPlanTier(a.planTier ?? undefined);
  const { allowance } = await loadPlanAllowance(
    { db: deps.db, now: deps.now, env: deps.env, entitlements: deps.entitlements },
    a.organisationId,
    tier,
  );
  if (allowance.remaining !== null && allowance.remaining <= 0) return pause(deps, a, 'allowance');
  // Each period snapshots the mix as it is now (swipes and "make more like this" included).
  const mix = await getMix(deps.db, { organisationId: a.organisationId, businessId: a.businessId });
  const moved = await deps.db.automation.updateMany({
    where: { id: a.id, status: 'ACTIVE', currentPlanId: plan.id },
    data: {
      status: 'GENERATING',
      periodIndex: a.periodIndex + 1,
      mixSnapshot: mix as unknown as Prisma.InputJsonValue,
    },
  });
  if (moved.count === 0) return null;
  const fresh = await deps.db.automation.findUniqueOrThrow({ where: { id: a.id } });
  const draft = await draftPeriod(
    {
      db: deps.db,
      queue: deps.queue,
      now: deps.now,
      env: deps.env,
      entitlements: deps.entitlements,
    },
    { ...fresh, periodIndex: a.periodIndex },
    nextPeriodStart(plan),
    mix,
  );
  if (!draft.plan) {
    await deps.db.automation.update({
      where: { id: a.id },
      data: { status: 'ACTIVE', periodIndex: a.periodIndex },
    });
    return pause(deps, { ...a, status: 'ACTIVE' }, draft.reason ?? 'no_free_slots');
  }
  await deps.db.automation.update({ where: { id: a.id }, data: { currentPlanId: draft.plan.id } });
  audit(deps, a, 'studio.automation.rollover', {
    planId: draft.plan.id,
    period: a.periodIndex + 1,
  });
  return 'rolledOver';
}

// ------------------------------------------------------------------ weekly insight

/** The best post of the automation's last week by views (analytics polling), or null. */
export async function topPost(
  db: PrismaClient,
  a: Pick<Automation, 'id' | 'organisationId'>,
  since: Date,
) {
  const items = await db.contentPlanItem.findMany({
    where: {
      organisationId: a.organisationId,
      plan: { automationId: a.id },
      status: 'POSTED',
      slotAt: { gte: since },
      projectId: { not: null },
    },
    select: { id: true, title: true, format: true, angleId: true, projectId: true },
  });
  if (items.length === 0) return null;
  const views = await db.videoAnalytic.groupBy({
    by: ['publicationId'],
    where: { publication: { projectId: { in: items.map((i) => i.projectId!) } } },
    _sum: { views: true },
  });
  const pubs = await db.videoPublication.findMany({
    where: { id: { in: views.map((v) => v.publicationId) } },
    select: { id: true, projectId: true },
  });
  const projectOf = new Map(pubs.map((p) => [p.id, p.projectId]));
  const byProject = new Map<string, number>();
  for (const v of views) {
    const projectId = projectOf.get(v.publicationId);
    if (projectId) byProject.set(projectId, (byProject.get(projectId) ?? 0) + (v._sum.views ?? 0));
  }
  let best: { item: (typeof items)[number]; views: number } | null = null;
  for (const item of items) {
    const n = byProject.get(item.projectId!) ?? 0;
    if (!best || n > best.views) best = { item, views: n };
  }
  return best && best.views > 0 ? best : null;
}

async function maybeInsight(deps: AutomationRunDeps, a: Automation): Promise<void> {
  const now = deps.now();
  const last = a.lastInsightAt?.getTime() ?? a.activatedAt?.getTime() ?? now;
  if (now - last < INSIGHT_EVERY_DAYS * DAY_MS) return;
  const claimed = await deps.db.automation.updateMany({
    where: { id: a.id, lastInsightAt: a.lastInsightAt },
    data: { lastInsightAt: new Date(now) },
  });
  if (claimed.count === 0) return;
  const best = await topPost(deps.db, a, new Date(now - INSIGHT_EVERY_DAYS * DAY_MS));
  if (!best) return;
  await deps.db.automation.update({
    where: { id: a.id },
    data: {
      metadata: {
        ...((a.metadata as Record<string, unknown> | null) ?? {}),
        insight: {
          at: new Date(now).toISOString(),
          itemId: best.item.id,
          title: best.item.title,
          format: best.item.format,
          angleId: best.item.angleId,
          views: best.views,
        },
      } as Prisma.InputJsonValue,
    },
  });
  await notify(
    deps,
    a,
    'automationInsight',
    { title: best.item.title.slice(0, 80), views: best.views },
    `automation-insight:${a.id}:${Math.floor(now / (INSIGHT_EVERY_DAYS * DAY_MS))}`,
  );
}

/** POST /automations/:id/more-like-this — nudge the insight's format and angle up (bounded). */
export async function moreLikeThis(
  db: PrismaClient,
  tenant: Pick<TenantContext, 'organisationId' | 'userId'>,
  a: Automation,
) {
  const insight = (a.metadata as { insight?: { format?: string; angleId?: string | null } } | null)
    ?.insight;
  if (!insight?.format || !isFormatKey(insight.format)) return null;
  const angle = insight.angleId
    ? await db.contentAngle.findFirst({
        where: { id: insight.angleId, organisationId: a.organisationId, businessId: a.businessId },
        select: { id: true, title: true },
      })
    : null;
  await recordSignal(
    db,
    { organisationId: a.organisationId, businessId: a.businessId },
    tenant.userId,
    {
      action: 'more_like_this',
      format: insight.format,
      angle,
    },
  );
  return { format: insight.format, angle: angle?.title ?? null };
}
