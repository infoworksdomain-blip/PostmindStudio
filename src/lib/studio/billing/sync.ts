import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { AuditAction } from '../../audit-sink';
import type { AuthEmailTemplate, AuthMailer } from '../../email/auth-mailer';
import {
  ENDED_STATUSES,
  entitlementsFromSubscription,
  graceEndsAt,
  parseOverrides,
  resolveStoredEntitlements,
  trialStateFor,
  type DerivedEntitlement,
  type EntitlementOverrides,
} from './entitlements';
import { invalidateEntitlements, type Entitlements } from './entitlements-reader';
import type { StripeGateway, SubscriptionState } from './gateway';

// Phase 18 §2.7 / §P.3 — Stripe state → studio.subscriptions + studio.org_entitlements.
//
//   - The organisation is ALWAYS found through billing_customers (the customer Studio created for
//     it), never from metadata.organisationId alone (§5.7). A subscription for an unknown customer
//     is logged and ignored.
//   - Callers pass the subscription as just re-fetched from the API (webhook.ts, reconcile.ts),
//     so event payload order never matters: the latest API state always wins.
//   - An organisation may hold several subscription rows (an old cancelled one and a new one);
//     the governing one is the best status, then the newest.

type Env = Record<string, string | undefined>;

export type BillingDb = PrismaClient;

export interface BillingSyncDeps {
  db: BillingDb;
  gateway: StripeGateway;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  now: () => number;
  env?: Env;
  /** Billing emails to owners (Track B); absent = logged only. */
  mailer?: AuthMailer;
  appUrl?: string;
}

export const STRIPE_ACTOR = 'system:stripe';

/** Lower is better: which subscription governs an organisation with several. */
const STATUS_RANK: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  unpaid: 3,
  paused: 4,
  incomplete: 5,
  canceled: 6,
  incomplete_expired: 7,
};

function rank(status: string): number {
  return STATUS_RANK[status] ?? 8;
}

export async function organisationForCustomer(
  db: Pick<PrismaClient, 'billingCustomer'>,
  customerId: string | null,
): Promise<string | null> {
  if (!customerId) return null;
  const row = await db.billingCustomer.findUnique({
    where: { stripeCustomerId: customerId },
    select: { organisationId: true, deletedAt: true },
  });
  return row && !row.deletedAt ? row.organisationId : null;
}

interface StoredSubscription {
  id: string;
  status: string;
  lookupKey: string | null;
  productTier: string | null;
  trialEnd: Date | null;
  createdAt: Date;
}

export function governingSubscription<T extends StoredSubscription>(rows: T[]): T | null {
  return (
    rows
      .slice()
      .sort(
        (a, b) => rank(a.status) - rank(b.status) || b.createdAt.getTime() - a.createdAt.getTime(),
      )[0] ?? null
  );
}

function subscriptionData(state: SubscriptionState, organisationId: string, now: Date) {
  return {
    organisationId,
    stripeCustomerId: state.customerId,
    status: state.status,
    lookupKey: state.lookupKey,
    interval: state.interval,
    currentPeriodStart: state.currentPeriodStart,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    trialEnd: state.trialEnd,
    productTier: state.productTier,
    unitAmountPence: state.unitAmountPence,
    currency: state.currency,
    quantity: state.quantity,
    stripeUpdatedAt: now,
  };
}

export interface SyncResult {
  organisationId: string;
  before: Entitlements | null;
  after: Entitlements;
  derived: DerivedEntitlement;
}

/**
 * Store one subscription's current state and recompute the organisation's entitlements.
 * Returns null when the customer is not one of ours.
 */
export async function syncSubscription(
  deps: BillingSyncDeps,
  state: SubscriptionState,
  cause: string,
): Promise<SyncResult | null> {
  const organisationId = await organisationForCustomer(deps.db, state.customerId);
  if (!organisationId) {
    deps.logger.warn(
      { subscriptionId: state.id, cause },
      'stripe subscription for a customer Studio does not know; ignored',
    );
    return null;
  }
  if (state.metadataOrganisationId && state.metadataOrganisationId !== organisationId) {
    deps.logger.warn(
      { subscriptionId: state.id, organisationId, cause },
      'subscription metadata names another organisation; billing_customers wins',
    );
  }
  const now = new Date(deps.now());
  const data = subscriptionData(state, organisationId, now);
  await deps.db.subscription.upsert({
    where: { id: state.id },
    create: { id: state.id, ...data },
    update: data,
  });
  return recomputeEntitlements(deps, organisationId, cause);
}

/** Recompute an organisation's entitlements from its stored subscription rows. */
export async function recomputeEntitlements(
  deps: BillingSyncDeps,
  organisationId: string,
  cause: string,
): Promise<SyncResult> {
  const now = new Date(deps.now());
  const [rows, existing] = await Promise.all([
    deps.db.subscription.findMany({ where: { organisationId } }),
    deps.db.orgEntitlement.findUnique({ where: { organisationId } }),
  ]);
  const governing = governingSubscription(rows);
  const overrides = parseOverrides(existing?.overrides);
  const graceUntil =
    governing?.status === 'past_due' ? (existing?.graceUntil ?? graceEndsAt(now, deps.env)) : null;
  const derived = entitlementsFromSubscription({
    subscription: governing,
    now,
    graceUntil,
    everPaid: Boolean(existing?.everPaidAt),
  });
  const trialing = governing?.status === 'trialing';
  const trialStartedAt = existing?.trialStartedAt ?? (trialing ? now : null);
  // Retention clock: starts when a paid organisation's governing subscription has ended, stops
  // (and is forgotten) as soon as it subscribes again.
  const ended =
    Boolean(existing?.everPaidAt) && (!governing || ENDED_STATUSES.has(governing.status));
  const { retention: previousRetention, ...rest } = overrides;
  const nextOverrides: EntitlementOverrides = {
    ...rest,
    ...(ended && {
      retention: previousRetention ?? { cancelledAt: now.toISOString() },
    }),
    derived: {
      tier: derived.tier,
      access: derived.access,
      source: derived.source,
      status: derived.status,
    },
    ...(trialing &&
      trialStartedAt && {
        trial: overrides.trial ?? trialStateFor(trialStartedAt, governing?.trialEnd ?? null),
      }),
  };
  const before = existing ? resolveStoredEntitlements(existing, now) : null;
  const effective = resolveStoredEntitlements(
    {
      organisationId,
      tier: derived.tier,
      access: derived.access,
      source: derived.source,
      graceUntil,
      overrides: nextOverrides,
      everPaidAt: existing?.everPaidAt ?? null,
    },
    now,
  );
  const row = {
    tier: effective.tier,
    access: effective.access,
    source: effective.source,
    graceUntil,
    trialStartedAt,
    overrides: nextOverrides as Prisma.InputJsonValue,
    reason: cause.slice(0, 200),
  };
  await deps.db.orgEntitlement.upsert({
    where: { organisationId },
    create: { organisationId, ...row },
    update: row,
  });
  invalidateEntitlements(organisationId);
  if (!before || before.tier !== effective.tier || before.access !== effective.access) {
    deps.audit({
      actorUserId: STRIPE_ACTOR,
      organisationId,
      action: AuditAction.BillingSubscriptionChanged,
      resource: { type: 'organisation', id: organisationId },
      metadata: {
        cause,
        status: derived.status,
        from: before ? { tier: before.tier, access: before.access } : null,
        to: { tier: effective.tier, access: effective.access, source: effective.source },
      },
    });
  }
  return { organisationId, before, after: effective, derived };
}

/** invoice.payment_failed: start the grace clock (first failure only). */
export async function startGrace(deps: BillingSyncDeps, organisationId: string): Promise<Date> {
  const now = new Date(deps.now());
  const existing = await deps.db.orgEntitlement.findUnique({ where: { organisationId } });
  if (existing?.graceUntil) return existing.graceUntil;
  const graceUntil = graceEndsAt(now, deps.env);
  await deps.db.orgEntitlement.upsert({
    where: { organisationId },
    create: {
      organisationId,
      tier: 'BASIC',
      access: 'none',
      source: 'none',
      graceUntil,
      reason: 'invoice.payment_failed',
    },
    update: { graceUntil },
  });
  invalidateEntitlements(organisationId);
  return graceUntil;
}

/** invoice.paid: clear the grace clock and remember the organisation has paid. */
export async function markPaid(deps: BillingSyncDeps, organisationId: string): Promise<void> {
  const now = new Date(deps.now());
  await deps.db.orgEntitlement.upsert({
    where: { organisationId },
    create: {
      organisationId,
      tier: 'BASIC',
      access: 'none',
      source: 'none',
      everPaidAt: now,
      reason: 'invoice.paid',
    },
    update: { graceUntil: null, everPaidAt: now },
  });
  invalidateEntitlements(organisationId);
}

// ------------------------------------------------------------------ owner emails

export async function ownerRecipients(
  db: Pick<PrismaClient, 'member'>,
  organisationId: string,
): Promise<Array<{ userId: string; email: string; locale: string }>> {
  const owners = await db.member.findMany({
    where: { organizationId: organisationId, role: 'owner' },
    select: { user: { select: { id: true, email: true, locale: true, deletedAt: true } } },
  });
  return owners
    .filter((m) => !m.user.deletedAt)
    .map((m) => ({ userId: m.user.id, email: m.user.email, locale: m.user.locale ?? 'en-GB' }));
}

/** Email every owner; failures are logged, never thrown (the webhook must still succeed). */
export async function emailOwners(
  deps: Pick<BillingSyncDeps, 'db' | 'logger' | 'mailer'>,
  organisationId: string,
  template: AuthEmailTemplate,
  params: Record<string, string | number | boolean | null>,
  idempotencyKey: string,
): Promise<number> {
  if (!deps.mailer) {
    deps.logger.info({ organisationId, template }, 'billing email not sent (no mailer configured)');
    return 0;
  }
  let sent = 0;
  try {
    for (const owner of await ownerRecipients(deps.db, organisationId)) {
      await deps.mailer.sendAuthEmail(template, owner.email, params, owner.locale, {
        idempotencyKey: `${idempotencyKey}:${owner.userId}`,
        organisationId,
        userId: owner.userId,
      });
      sent += 1;
    }
  } catch (err) {
    deps.logger.error({ err, organisationId, template }, 'billing email could not be queued');
  }
  return sent;
}
