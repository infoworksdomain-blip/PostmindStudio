import { Prisma, type PrismaClient } from '@prisma/client';
import {
  LEGACY_TOP_UP_PACKS,
  topUpPackForLookupKey,
  TOP_UP_PACKS,
  type TopUpPack,
} from './catalogue';
import type { ChargeState, CheckoutSessionState } from './gateway';
import { quartersToVideos, VIDEO_QUARTERS, videosToQuarters } from './allowance-units';

// Phase 18 §P.3 top-up packs. A paid Checkout session (mode=payment) inserts one usage_credits
// row per pack (unique per session, so a replayed webhook never credits twice). Credits are
// valid for the pack's months (21.5 HD packs: 3), used first-in first-out, and only once the plan allowance is used up:
// checkGenerateQuota (services/plan-quotas.ts) consumes one inside the per-(org, month) quota lock
// and records a usage_credit_uses row, unique per (project, month), so a retried generate never
// spends twice. Each consumed credit raises that month's cost cap by the pack's worst-case
// allowance (creditHeadroomPence → cost/guard.ts), so paid credits are never blocked by the cap.
//
// 23.3: pack balances are counted in QUARTERS of a video (billing/allowance-units.ts): a pack of
// 5 videos holds 20 quarters; a quick post (carousel, slideshow, wall of text, hook + demo) takes
// 1, a video 4, a UGC actor video 8. The legacy video columns (quantity, remaining) are written at
// purchase only.

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
  // Checked first (the common replay); the unique index still guards a concurrent delivery.
  const existing = await db.usageCredit.findUnique({
    where: { stripeCheckoutSessionId: session.id },
    select: { id: true },
  });
  if (existing) return { status: 'duplicate' };
  try {
    const credit = await db.usageCredit.create({
      data: {
        organisationId,
        kind: pack.kind,
        packLookupKey: pack.lookupKey,
        quantity: pack.quantity,
        remaining: pack.quantity,
        quantityQuarters: videosToQuarters(pack.quantity),
        remainingQuarters: videosToQuarters(pack.quantity),
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

/** 23.3: pack quarters the organisation can still use, by kind (integers). */
export async function availableCreditQuarters(
  db: Pick<PrismaClient, 'usageCredit'>,
  organisationId: string,
  now: Date,
): Promise<Record<CreditKind, number>> {
  const rows = await db.usageCredit.groupBy({
    by: ['kind'],
    where: {
      organisationId,
      remainingQuarters: { gt: 0 },
      refundedAt: null,
      expiresAt: { gt: now },
    },
    _sum: { remainingQuarters: true },
  });
  const out: Record<CreditKind, number> = { short: 0, long: 0 };
  for (const row of rows) {
    if (row.kind === 'short' || row.kind === 'long')
      out[row.kind] = row._sum.remainingQuarters ?? 0;
  }
  return out;
}

/**
 * Pack videos the organisation can still use, by kind (the settings page and the upgrade
 * dialog). 23.3: a whole or quarter number of videos (4.75 after three quick posts on 5 videos).
 */
export async function availableCredits(
  db: Pick<PrismaClient, 'usageCredit'>,
  organisationId: string,
  now: Date,
): Promise<Record<CreditKind, number>> {
  const quarters = await availableCreditQuarters(db, organisationId, now);
  return { short: quartersToVideos(quarters.short), long: quartersToVideos(quarters.long) };
}

export interface CreditUse {
  id: string;
  creditId: string;
  reused: boolean;
}

/**
 * Consume `quarters` of one credit of `kind` for (project, month), first-in first-out. Returns the
 * existing use when the project already consumed one this month (a retried generate), null when
 * no single pack has enough left. Call inside the quota lock's transaction.
 */
export async function consumeCredit(
  tx: CreditDb,
  input: {
    organisationId: string;
    projectId: string;
    month: string;
    kind: CreditKind;
    now: Date;
    /**
     * 23.3: quarters of a video this generation uses (ugc/allowance.ts allowanceQuartersOf: a
     * quick post 1, a video 4 — the default —, a UGC actor video 8).
     */
    quarters?: number;
  },
): Promise<CreditUse | null> {
  const units = Math.max(1, Math.floor(input.quarters ?? VIDEO_QUARTERS));
  const existing = await tx.usageCreditUse.findUnique({
    where: { projectId_month: { projectId: input.projectId, month: input.month } },
  });
  if (existing) {
    // Project ids are unique, so another organisation's row here is impossible; never reuse it.
    if (existing.organisationId !== input.organisationId) return null;
    return { id: existing.id, creditId: existing.creditId, reused: true };
  }
  const candidates = await tx.usageCredit.findMany({
    where: {
      organisationId: input.organisationId,
      kind: input.kind,
      remainingQuarters: { gte: units },
      refundedAt: null,
      expiresAt: { gt: input.now },
    },
    orderBy: [{ purchasedAt: 'asc' }, { id: 'asc' }],
    take: 5,
  });
  for (const credit of candidates) {
    const taken = await tx.usageCredit.updateMany({
      where: { id: credit.id, remainingQuarters: { gte: units } },
      data: { remainingQuarters: { decrement: units } },
    });
    if (taken.count === 0) continue;
    const use = await tx.usageCreditUse.create({
      data: {
        creditId: credit.id,
        organisationId: input.organisationId,
        projectId: input.projectId,
        month: input.month,
        kind: input.kind,
        quarters: units,
      },
    });
    return { id: use.id, creditId: credit.id, reused: false };
  }
  return null;
}

// 21.5: legacy packs bought before the HD packs keep their headroom until they expire.
const HEADROOM_BY_PACK = new Map(
  [...TOP_UP_PACKS, ...LEGACY_TOP_UP_PACKS].map((p) => [p.lookupKey, p]),
);

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
  // 23.3: in quarters of a video; a spent use took its own quarters (a quick post 1, a video 4).
  const refundedQuarters = Math.ceil(credit.quantityQuarters * share);
  const spent = await db.usageCreditUse.aggregate({
    where: { creditId: credit.id },
    _sum: { quarters: true },
  });
  const newRemaining = Math.min(
    credit.remainingQuarters,
    Math.max(0, credit.quantityQuarters - refundedQuarters - (spent._sum.quarters ?? 0)),
  );
  await db.usageCredit.update({
    where: { id: credit.id },
    data: {
      remainingQuarters: newRemaining,
      ...(charge.refunded && { refundedAt: credit.refundedAt ?? now }),
    },
  });
  // `removed` is in pack videos (a quarter number: 1.25 = 5 quarters).
  return {
    creditId: credit.id,
    removed: quartersToVideos(credit.remainingQuarters - newRemaining),
  };
}
