import { Prisma, type PrismaClient } from '@prisma/client';
import { topUpPackForLookupKey, TOP_UP_PACKS, type TopUpPack } from './catalogue';
import type { ChargeState, CheckoutSessionState } from './gateway';

// Phase 18 §P.3 top-up packs. A paid Checkout session (mode=payment) inserts one usage_credits
// row per pack (unique per session, so a replayed webhook never credits twice). Credits are
// valid for 12 months, used first-in first-out, and only once the plan allowance is used up:
// checkGenerateQuota (services/plan-quotas.ts) consumes one inside the per-(org, month) quota lock
// and records a usage_credit_uses row, unique per (project, month), so a retried generate never
// spends twice. Each consumed credit raises that month's cost cap by the pack's worst-case
// allowance (creditHeadroomPence → cost/guard.ts), so paid credits are never blocked by the cap.

export type CreditKind = 'short' | 'long';

type CreditDb = Pick<PrismaClient, 'usageCredit' | 'usageCreditUse'>;

export function addMonths(at: Date, months: number): Date {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export type TopUpOutcome =
  | { status: 'credited'; creditId: string; pack: TopUpPack }
  | { status: 'duplicate' | 'not_paid' | 'unknown_pack' };

/** A paid top-up Checkout session → one credit row (idempotent per session). */
export async function creditTopUp(
  db: CreditDb,
  session: CheckoutSessionState,
  organisationId: string,
  now: Date,
): Promise<TopUpOutcome> {
  const pack = topUpPackForLookupKey(session.metadata.studio_topup ?? '');
  if (!pack) return { status: 'unknown_pack' };
  if (session.paymentStatus !== 'paid') return { status: 'not_paid' };
  try {
    const credit = await db.usageCredit.create({
      data: {
        organisationId,
        kind: pack.kind,
        packLookupKey: pack.lookupKey,
        quantity: pack.quantity,
        remaining: pack.quantity,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.paymentIntentId,
        purchasedAt: now,
        expiresAt: addMonths(now, pack.validMonths),
      },
    });
    return { status: 'credited', creditId: credit.id, pack };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'duplicate' };
    throw err;
  }
}

/** Credits the organisation can still use, by kind (the settings page and the upgrade dialog). */
export async function availableCredits(
  db: Pick<PrismaClient, 'usageCredit'>,
  organisationId: string,
  now: Date,
): Promise<Record<CreditKind, number>> {
  const rows = await db.usageCredit.groupBy({
    by: ['kind'],
    where: { organisationId, remaining: { gt: 0 }, refundedAt: null, expiresAt: { gt: now } },
    _sum: { remaining: true },
  });
  const out: Record<CreditKind, number> = { short: 0, long: 0 };
  for (const row of rows) {
    if (row.kind === 'short' || row.kind === 'long') out[row.kind] = row._sum.remaining ?? 0;
  }
  return out;
}

export interface CreditUse {
  id: string;
  creditId: string;
  reused: boolean;
}

/**
 * Consume one credit of `kind` for (project, month), first-in first-out. Returns the existing use
 * when the project already consumed one this month (a retried generate), null when none is left.
 * Call inside the quota lock's transaction.
 */
export async function consumeCredit(
  tx: CreditDb,
  input: { organisationId: string; projectId: string; month: string; kind: CreditKind; now: Date },
): Promise<CreditUse | null> {
  const existing = await tx.usageCreditUse.findUnique({
    where: { projectId_month: { projectId: input.projectId, month: input.month } },
  });
  if (existing) return { id: existing.id, creditId: existing.creditId, reused: true };
  const candidates = await tx.usageCredit.findMany({
    where: {
      organisationId: input.organisationId,
      kind: input.kind,
      remaining: { gt: 0 },
      refundedAt: null,
      expiresAt: { gt: input.now },
    },
    orderBy: [{ purchasedAt: 'asc' }, { id: 'asc' }],
    take: 5,
  });
  for (const credit of candidates) {
    const taken = await tx.usageCredit.updateMany({
      where: { id: credit.id, remaining: { gt: 0 } },
      data: { remaining: { decrement: 1 } },
    });
    if (taken.count === 0) continue;
    const use = await tx.usageCreditUse.create({
      data: {
        creditId: credit.id,
        organisationId: input.organisationId,
        projectId: input.projectId,
        month: input.month,
        kind: input.kind,
      },
    });
    return { id: use.id, creditId: credit.id, reused: false };
  }
  return null;
}

const HEADROOM_BY_PACK = new Map(TOP_UP_PACKS.map((p) => [p.lookupKey, p]));

/** Extra monthly cost-cap headroom from the credits consumed in `month` ('YYYY-MM'). */
export async function creditHeadroomPence(
  db: Pick<PrismaClient, 'usageCreditUse' | 'usageCredit'>,
  organisationId: string,
  month: string,
): Promise<number> {
  const uses = await db.usageCreditUse.findMany({
    where: { organisationId, month },
    select: { creditId: true },
  });
  if (uses.length === 0) return 0;
  const credits = await db.usageCredit.findMany({
    where: { id: { in: [...new Set(uses.map((u) => u.creditId))] } },
    select: { id: true, packLookupKey: true },
  });
  const packOf = new Map(credits.map((c) => [c.id, HEADROOM_BY_PACK.get(c.packLookupKey)]));
  return uses.reduce((sum, u) => sum + (packOf.get(u.creditId)?.capHeadroomPencePerCredit ?? 0), 0);
}

/**
 * charge.refunded on a top-up: remove the refunded share of the pack's credits (amount_refunded is
 * cumulative, so a partial then a full refund converge), never touching credits already spent.
 * A full refund marks the pack refunded.
 */
export async function refundTopUpCredits(
  db: Pick<PrismaClient, 'usageCredit' | 'usageCreditUse'>,
  charge: ChargeState,
  now: Date,
): Promise<{ creditId: string; removed: number } | null> {
  if (!charge.paymentIntentId || charge.amountRefunded <= 0) return null;
  const credit = await db.usageCredit.findFirst({
    where: { stripePaymentIntentId: charge.paymentIntentId },
  });
  if (!credit) return null;
  const share = charge.amount > 0 ? Math.min(1, charge.amountRefunded / charge.amount) : 1;
  const refundedCredits = Math.ceil(credit.quantity * share);
  const spent = await db.usageCreditUse.count({ where: { creditId: credit.id } });
  const newRemaining = Math.min(
    credit.remaining,
    Math.max(0, credit.quantity - refundedCredits - spent),
  );
  await db.usageCredit.update({
    where: { id: credit.id },
    data: {
      remaining: newRemaining,
      ...(charge.refunded && { refundedAt: credit.refundedAt ?? now }),
    },
  });
  return { creditId: credit.id, removed: credit.remaining - newRemaining };
}
