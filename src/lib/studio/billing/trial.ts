import { Prisma } from '@prisma/client';
import { AuditAction } from '../../audit-sink';
import type { SubscriptionState } from './gateway';
import { STRIPE_ACTOR, type BillingSyncDeps } from './sync';

// Phase 18 §2.7 / §8 trial abuse controls. One trial per organisation (checkout.ts only offers
// trial_period_days when the organisation never trialled) and one per card: when a trialing
// subscription's card fingerprint already had a trial for ANOTHER organisation — or the
// organisation already trialled on an earlier subscription — the trial is ended at once
// (subscriptions.update trial_end=now, https://docs.stripe.com/api/subscriptions/update#update_subscription-trial_end,
// read 2026-09-29), so Stripe charges the first invoice immediately. The trial's cost is capped
// at £15 in total by the cost guard (cost-adjustments.ts).

export type TrialCheck = 'not_trialing' | 'allowed' | 'ended_repeat_card' | 'ended_repeat_org';

async function fingerprintOf(
  deps: BillingSyncDeps,
  state: SubscriptionState,
): Promise<string | null> {
  const paymentMethod =
    state.defaultPaymentMethodId ??
    (await deps.gateway.customerDefaultPaymentMethod(state.customerId));
  if (!paymentMethod) return null;
  return deps.gateway.paymentMethodFingerprint(paymentMethod);
}

async function endTrial(
  deps: BillingSyncDeps,
  state: SubscriptionState,
  organisationId: string,
  reason: 'repeat_card' | 'repeat_org',
): Promise<void> {
  await deps.gateway.endTrialNow(state.id, `studio:trial-end:${state.id}`);
  deps.audit({
    actorUserId: STRIPE_ACTOR,
    organisationId,
    action: AuditAction.BillingSubscriptionChanged,
    resource: { type: 'subscription', id: state.id },
    metadata: { change: 'trial_ended_abuse_control', reason },
  });
  deps.logger.warn(
    { organisationId, subscriptionId: state.id, reason },
    'trial ended at once: trial abuse control',
  );
}

export async function enforceTrialRules(
  deps: BillingSyncDeps,
  state: SubscriptionState,
  organisationId: string,
): Promise<TrialCheck> {
  if (state.status !== 'trialing') return 'not_trialing';
  const earlier = await deps.db.subscription.findFirst({
    where: { organisationId, id: { not: state.id }, trialEnd: { not: null } },
    select: { id: true },
  });
  if (earlier) {
    await endTrial(deps, state, organisationId, 'repeat_org');
    return 'ended_repeat_org';
  }
  const fingerprint = await fingerprintOf(deps, state);
  if (!fingerprint) {
    // payment_method_collection=always means Checkout always has a card; log the anomaly.
    deps.logger.warn(
      { organisationId, subscriptionId: state.id },
      'trialing subscription without a card fingerprint',
    );
    return 'allowed';
  }
  const seen = await deps.db.trialFingerprint.findUnique({ where: { fingerprint } });
  if (seen && seen.organisationId !== organisationId) {
    await endTrial(deps, state, organisationId, 'repeat_card');
    return 'ended_repeat_card';
  }
  if (!seen) {
    try {
      await deps.db.trialFingerprint.create({ data: { fingerprint, organisationId } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // Another organisation stored the same card at the same moment: re-check who won.
      const winner = await deps.db.trialFingerprint.findUnique({ where: { fingerprint } });
      if (winner && winner.organisationId !== organisationId) {
        await endTrial(deps, state, organisationId, 'repeat_card');
        return 'ended_repeat_card';
      }
    }
  }
  return 'allowed';
}
