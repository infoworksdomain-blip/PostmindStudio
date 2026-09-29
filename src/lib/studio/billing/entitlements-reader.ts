import type { PlanTier } from '../providers/router';
import type { TenantAccess } from '../../tenant';

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

/**
 * The reader production wiring uses (identity/standalone.ts, context.ts). Track C points this at
 * the org_entitlements reader; until then every organisation has no plan.
 */
export async function entitlementsReaderFromEnv(): Promise<EntitlementsReader> {
  return createStubEntitlementsReader();
}
