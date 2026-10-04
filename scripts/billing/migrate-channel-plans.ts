import { PrismaClient } from '@prisma/client';
import { auditLog } from '../../src/lib/audit';
import { ConfigurationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  migrationIdempotencyKey,
  migrationUpdateParams,
  planChannelMigration,
} from '../../src/lib/studio/billing/channel-migration';
import { CHANNEL_LOOKUP_KEYS } from '../../src/lib/studio/billing/channel-plan';
import { createStripeGateway, toSubscriptionState } from '../../src/lib/studio/billing/gateway';
import { createStripeClient, isTestModeKey } from '../../src/lib/studio/billing/stripe-client';
import { syncSubscription } from '../../src/lib/studio/billing/sync';

// Phase 21.5 — move every old per-tier TEST-MODE subscription to the per-channel plan
// (operator decision 2026-10-04): Basic → 1 channel, Standard → 3, Plus → 6, all monthly on
// studio_channel_monthly (quantity = channels). Planning rules and the update params:
// src/lib/studio/billing/channel-migration.ts (unit tested).
//
//   Dry run (default; prints what it would do, writes nothing):
//     STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/migrate-channel-plans.ts
//   Apply:
//     STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/migrate-channel-plans.ts --apply
//
// Idempotent: subscriptions already on a channel price are skipped, and each Stripe update
// carries a fixed Idempotency-Key per subscription. After each update the subscription is
// re-fetched and stored (studio.subscriptions + org_entitlements), so Studio shows the channels
// at once; the customer.subscription.updated webhook arrives later and changes nothing more.
// Refuses live keys. Run scripts/billing/seed-stripe-test.ts first (the channel prices must
// exist). Runbook: runbooks/billing-stripe.md "21.5 migration".

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
    const [monthly] = (await gateway.listPrices([CHANNEL_LOOKUP_KEYS.month])).filter(
      (p) => p.active,
    );
    if (!monthly)
      throw new ConfigurationError(
        `No active price has the lookup key ${CHANNEL_LOOKUP_KEYS.month}: run seed-stripe-test.ts first`,
      );
    const subscriptions = [];
    for await (const sub of gateway.listSubscriptions()) subscriptions.push(sub);
    const steps = planChannelMigration(subscriptions);
    const counts: Record<string, number> = {};
    for (const step of steps) {
      counts[step.action] = (counts[step.action] ?? 0) + 1;
      if (step.action !== 'migrate') {
        logger.info({ subscription: step.subscriptionId, action: step.action }, 'skipped');
        continue;
      }
      const summary = {
        subscription: step.subscriptionId,
        from: step.fromLookupKey,
        to: step.toLookupKey,
        channels: step.channels,
        releaseSchedule: step.scheduleId ?? null,
      };
      if (!apply) {
        logger.info(summary, '[dry-run] would migrate');
        continue;
      }
      if (step.scheduleId)
        await stripe.subscriptionSchedules.release(
          step.scheduleId,
          {},
          {
            idempotencyKey: `${migrationIdempotencyKey(step.subscriptionId)}-release`,
          },
        );
      const updated = await stripe.subscriptions.update(
        step.subscriptionId,
        { ...migrationUpdateParams(step, monthly.id), expand: ['items.data.price.product'] },
        { idempotencyKey: migrationIdempotencyKey(step.subscriptionId) },
      );
      const synced = await syncSubscription(
        {
          db,
          gateway,
          logger,
          audit: auditLog,
          now: Date.now,
          env: process.env,
        },
        toSubscriptionState(updated),
        'migration:21.5',
      );
      logger.info(
        { ...summary, organisationId: synced?.organisationId ?? null },
        synced ? 'migrated and synced' : 'migrated (customer not known to this database)',
      );
    }
    logger.info({ counts, apply }, apply ? 'channel migration done' : 'channel migration dry run');
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'migrate-channel-plans failed');
  process.exit(1);
});
