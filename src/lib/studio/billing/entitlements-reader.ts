import type { PrismaClient } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import type { TenantAccess } from '../../tenant';
import type { ChannelInterval } from './channel-plan';
import { resolveStoredEntitlements, type CustomLimits, type TrialState } from './entitlements';

// Phase 18 §P.3 — the one place Studio reads an organisation's tier and access. Track C builds
// the real reader (org_entitlements + catalogue + overrides, cached 30 s, invalidated by the
// Stripe webhook and admin writes). Until then the stub below answers "no plan".

export type EntitlementSource = 'stripe' | 'trial' | 'admin' | 'core' | 'none';

/** Per-organisation limits; null = unlimited. */
export interface EntitlementLimits {
  seats: number | null;
  businesses: number | null;
  storageGb: number | null;
}

export interface Entitlements {
  tier: PlanTier;
  access: TenantAccess;
  source: EntitlementSource;
  /** End of the failed-payment grace period (access stays full until then, with a banner). */
  graceUntil?: Date;
  limits: EntitlementLimits;
  /** Track C: per-organisation custom limits (ENTERPRISE or an admin override). */
  custom?: CustomLimits;
  /** Track C: the trial allowance and caps while the subscription is trialing. */
  trial?: TrialState;
  /** Track C: the Stripe status the entitlement came from (banners). */
  subscriptionStatus?: string;
  /**
   * 21.5: the per-channel plan in force (Stripe quantity + interval, or a staff override). Absent
   * on legacy tier subscriptions, ENTERPRISE and organisations without a plan.
   */
  channelPlan?: ChannelPlanEntitlement;
}

export interface ChannelPlanEntitlement {
  channels: number;
  interval: ChannelInterval;
  source: 'stripe' | 'admin';
}

export interface EntitlementsReader {
  forOrganisation(organisationId: string): Promise<Entitlements>;
  /** Drop the cached value (webhook or admin write). */
  invalidate(organisationId: string): void;
}

/** What an organisation without a plan gets: sign in and set up, but no generation (§P.1). */
export const NO_PLAN_ENTITLEMENTS: Entitlements = Object.freeze({
  tier: 'BASIC',
  access: 'none',
  source: 'none',
  limits: Object.freeze({ seats: 2, businesses: 1, storageGb: 25 }),
}) as Entitlements;

/** Track 0 stub: every organisation has no plan until Track C lands. */
export function createStubEntitlementsReader(): EntitlementsReader {
  return {
    async forOrganisation() {
      return NO_PLAN_ENTITLEMENTS;
    },
    invalidate() {
      // nothing cached
    },
  };
}

// ------------------------------------------------------------------ Track C: the real reader

export const ENTITLEMENTS_CACHE_TTL_MS = 30_000;
const CACHE_MAX = 10_000;

/**
 * Reads studio.org_entitlements (written by the Stripe webhook, the nightly reconcile and admin
 * overrides) and resolves it at read time (grace clock, admin override expiry). Cached per
 * organisation for 30 s; `invalidate` drops one entry (webhook and admin writes call it through
 * invalidateEntitlements). Other processes pick a change up within the TTL, like the kill switch.
 * An organisation with no row has no plan (NO_PLAN_ENTITLEMENTS).
 */
export function createEntitlementsReader(options: {
  db: Pick<PrismaClient, 'orgEntitlement'>;
  now?: () => number;
  ttlMs?: number;
}): EntitlementsReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ENTITLEMENTS_CACHE_TTL_MS;
  const cache = new Map<string, { value: Entitlements; at: number }>();
  return {
    async forOrganisation(organisationId) {
      const hit = cache.get(organisationId);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const row = await options.db.orgEntitlement.findUnique({ where: { organisationId } });
      const value = row ? resolveStoredEntitlements(row, new Date(now())) : NO_PLAN_ENTITLEMENTS;
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(organisationId, { value, at: now() });
      return value;
    },
    invalidate(organisationId) {
      cache.delete(organisationId);
    },
  };
}

// One reader per process, so the webhook and admin writes invalidate the cache the API reads.
const readers = new Set<EntitlementsReader>();

/** Register a reader for process-wide invalidation (wiring.ts does it for the shared reader). */
export function registerEntitlementsReader(reader: EntitlementsReader): () => void {
  readers.add(reader);
  return () => readers.delete(reader);
}

/** Drop the cached entitlements of one organisation in every registered reader. */
export function invalidateEntitlements(organisationId: string): void {
  for (const reader of readers) reader.invalidate(organisationId);
}

/**
 * The reader production wiring uses (identity/standalone.ts, auth/server.ts). With Stripe
 * billing (the standalone default) it is the process-wide org_entitlements reader, registered for
 * invalidation by the webhook and admin writes; otherwise no organisation has a plan.
 */
export async function entitlementsReaderFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<EntitlementsReader> {
  const { studioModes } = await import('../../mode');
  if (studioModes(env).billing !== 'stripe') return createStubEntitlementsReader();
  const [{ prisma }, { sharedEntitlementsReader }] = await Promise.all([
    import('../../prisma'),
    import('./wiring'),
  ]);
  return sharedEntitlementsReader(prisma);
}
