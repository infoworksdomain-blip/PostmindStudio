import { PrismaClient } from '@prisma/client';
import { auditLog } from '../../src/lib/audit';
import { ConfigurationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { createStripeGateway, toSubscriptionState } from '../../src/lib/studio/billing/gateway';
import { createStripeClient, isTestModeKey } from '../../src/lib/studio/billing/stripe-client';
import { syncSubscription } from '../../src/lib/studio/billing/sync';
import { runTierMigration } from '../../src/lib/studio/billing/tier-migration';

// Phase 26.1 — move every legacy subscription to the three plans (operator decision 2026-10-09):
// a 21.5 per-channel subscription (studio_channel_<interval>, quantity = channels) to the same
// interval of 1 channel → Starter, 2–3 → Growth, 4+ → Pro; any 2026-09-30 tier price left
// (Basic / Standard / Plus) to Starter / Growth / Pro. Quantity 1, proration_behavior=none.
// Planning rules, the update params and the run loop: src/lib/studio/billing/tier-migration.ts
// (unit tested with a fake Stripe client).
//
//   Dry run (default; prints what it would do, writes nothing):
//     STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/migrate-to-tiers.ts
//   Apply:
//     STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/migrate-to-tiers.ts --apply
//
// Idempotent: subscriptions already on a plan price are skipped, and each Stripe update carries
// a fixed Idempotency-Key per subscription. After each update the subscription is stored
// (studio.subscriptions + org_entitlements), so Studio shows the plan at once; the
// customer.subscription.updated webhook arrives later and changes nothing more. Refuses live
// keys. Run scripts/billing/seed-stripe-test.ts first (the plan prices must exist). Runbook:
// runbooks/billing-stripe.md "26.1 migration".

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new ConfigurationError('STRIPE_SECRET_KEY is not set');
  if (!isTestModeKey(key))
    throw new ConfigurationError('Refusing to migrate: STRIPE_SECRET_KEY is not a test-mode key');
  if (!process.env.DATABASE_URL) throw new ConfigurationError('DATABASE_URL is not set');
  const stripe = createStripeClient(key);
  const gateway = createStripeGateway(stripe);
  const db = new PrismaClient();
  try {
    const result = await runTierMigration({
      apply,
      logger,
      client: {
        listSubscriptions: () => gateway.listSubscriptions(),
        listPrices: (keys) => gateway.listPrices(keys),
        releaseSchedule: (scheduleId, idempotencyKey) =>
          gateway.releaseSchedule(scheduleId, idempotencyKey),
        updateSubscription: async (id, params, idempotencyKey) =>
          toSubscriptionState(
            await stripe.subscriptions.update(
              id,
              { ...params, expand: ['items.data.price.product'] },
              { idempotencyKey },
            ),
          ),
      },
      onMigrated: async (state) => {
        const synced = await syncSubscription(
          { db, gateway, logger, audit: auditLog, now: Date.now, env: process.env },
          state,
          'migration:26.1',
        );
        return synced?.organisationId ?? null;
      },
    });
    logger.info(
      { counts: result.counts, apply },
      apply ? 'tier migration done' : 'tier migration dry run',
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'migrate-to-tiers failed');
  process.exit(1);
});
