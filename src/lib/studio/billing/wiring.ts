import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type Stripe from 'stripe';
import type { AuditEntry } from '../../audit';
import type { AuthMailer } from '../../email/auth-mailer';
import { studioModes, type StudioModes } from '../../mode';
import type { CapAdjustmentLookup } from '../cost/guard';
import type { BillingService } from './contracts';
import { createCapAdjustmentLookup } from './cost-adjustments';
import {
  createEntitlementsReader,
  registerEntitlementsReader,
  type EntitlementsReader,
} from './entitlements-reader';
import { createStripeGateway, type StripeGateway } from './gateway';
import { billingAccessFrom, type BillingAccessLookup } from './job-access';
import { createPricingSource, type PricingSource } from './pricing';
import { createBillingService } from './service';
import { stripeFromEnv } from './stripe-client';
import type { WebhookDeps } from './webhook';

// Phase 18 Track C — builds the billing pieces for each process from env. Only these functions
// read STUDIO_BILLING / STRIPE_*; everything else receives its dependencies.
//   API (studio/api/context.ts): entitlements reader + BillingService
//   workers (pipeline/create-deps.ts): billing access at job start + cost-cap adjustments
//   webhook route + scheduled jobs: WebhookDeps (gateway, constructEvent, sync deps)

type Env = Record<string, string | undefined>;

export type BillingJobDeps = WebhookDeps;

function stripeBilling(env: Env): boolean {
  return studioModes(env).billing === 'stripe';
}

let sharedReader: { db: PrismaClient; reader: EntitlementsReader } | undefined;

/** One entitlements reader per process (and per db), registered for invalidation. */
export function sharedEntitlementsReader(db: PrismaClient): EntitlementsReader {
  if (sharedReader?.db === db) return sharedReader.reader;
  const reader = createEntitlementsReader({ db });
  registerEntitlementsReader(reader);
  sharedReader = { db, reader };
  return reader;
}

export interface BillingApiDeps {
  modes: StudioModes;
  entitlements?: EntitlementsReader;
  billing?: BillingService;
}

export function billingApiDepsFromEnv(input: {
  db: PrismaClient;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  appUrl: string;
  env?: Env;
}): BillingApiDeps {
  const env = input.env ?? process.env;
  const modes = studioModes(env);
  if (modes.billing !== 'stripe') return { modes };
  const entitlements = sharedEntitlementsReader(input.db);
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    input.logger.warn('STRIPE_SECRET_KEY is not set: billing routes answer 501');
    return { modes, entitlements };
  }
  const billing = createBillingService({
    db: input.db,
    gateway: createStripeGateway(stripeFromEnv(env)),
    logger: input.logger,
    audit: input.audit,
    now: Date.now,
    appUrl: input.appUrl,
    env,
  });
  return { modes, entitlements, billing };
}

export interface BillingPipelineDeps {
  billingAccess?: BillingAccessLookup;
  adjustments?: CapAdjustmentLookup;
}

export function billingPipelineDepsFromEnv(db: PrismaClient, env: Env = process.env) {
  if (!stripeBilling(env)) return {} satisfies BillingPipelineDeps;
  const reader = sharedEntitlementsReader(db);
  return {
    billingAccess: billingAccessFrom(reader),
    adjustments: createCapAdjustmentLookup({ db, entitlements: reader }),
  } satisfies BillingPipelineDeps;
}

/** Verifies Stripe-Signature on the raw body (SDK default tolerance: 300 s). */
export function webhookVerifier(stripe: Stripe, secret: string) {
  return (raw: string, signature: string): Stripe.Event =>
    stripe.webhooks.constructEvent(raw, signature, secret);
}

/** Webhook route and scheduled billing jobs; undefined when Stripe is not configured. */
export function billingJobDepsFromEnv(input: {
  db: PrismaClient;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  mailer?: AuthMailer;
  notifyStaff?: WebhookDeps['notifyStaff'];
  gateway?: StripeGateway;
  env?: Env;
}): BillingJobDeps | undefined {
  const env = input.env ?? process.env;
  if (!stripeBilling(env)) return undefined;
  const key = env.STRIPE_SECRET_KEY?.trim();
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!key || !secret) return undefined;
  const stripe = stripeFromEnv(env);
  return {
    db: input.db,
    gateway: input.gateway ?? createStripeGateway(stripe),
    constructEvent: webhookVerifier(stripe, secret),
    logger: input.logger,
    audit: input.audit,
    now: Date.now,
    env,
    mailer: input.mailer,
    notifyStaff: input.notifyStaff,
  };
}

let pricing: PricingSource | undefined;

/** The process-wide pricing source (/pricing page and GET /billing/plans), 10-minute cache. */
export function pricingSourceFromEnv(logger: Logger, env: Env = process.env): PricingSource {
  if (pricing) return pricing;
  const key = env.STRIPE_SECRET_KEY?.trim();
  pricing = createPricingSource({
    gateway: key ? createStripeGateway(stripeFromEnv(env)) : undefined,
    logger,
    env,
  });
  return pricing;
}

/** Test hook. */
export function setPricingSource(next: PricingSource | undefined): void {
  pricing = next;
}
