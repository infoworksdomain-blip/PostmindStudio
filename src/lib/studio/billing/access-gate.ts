import { BillingRequiredError, PlanRequiredError } from '../../errors';
import type { StudioModes } from '../../mode';
import type { TenantAccess, TenantContext } from '../../tenant';
import { plusActive, type BetaPlanLookup } from '../services/beta';
import type { Entitlements, EntitlementsReader } from './entitlements-reader';

// Phase 18 §P.3 access gate. Every /api/studio route runs it (route.ts, one line) after the
// tenant is resolved:
//
//   access full       nothing blocked.
//   access none       (never subscribed / checkout unfinished) the org can set itself up — org,
//                     businesses, brand kit, connections, draft briefs — but every route that
//                     spends provider money or publishes answers 402 plan_required.
//   access read_only  (payment failed past grace, unpaid, cancelled after paying) every mutation
//                     answers 402 billing_required, except the allowlist: billing, account, org
//                     settings, members, notifications, export, downloads and deletes.
// Reads (GET / HEAD / OPTIONS) are never blocked. Workers repeat the check at job start
// (job-access.ts), so work queued before the change pauses cleanly.

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Mutations a read_only organisation may still make (path under /api/studio). */
export const READ_ONLY_ALLOWLIST: readonly RegExp[] = [
  /^\/billing(\/|$)/,
  /^\/account(\/|$)/,
  /^\/org(\/|$)/,
  /^\/organisations(\/|$)/,
  /^\/members(\/|$)/,
  /^\/invitations(\/|$)/,
  /^\/notifications(\/|$)/,
  /^\/notification-preferences(\/|$)/,
  /^\/renders\/[^/]+\/download$/,
  /^\/feedback$/,
  // Staff act on other organisations from their own; their routes check platform staff.
  /^\/admin(\/|$)/,
];

/** Routes that spend provider money, publish or scan: closed to an organisation with no plan. */
export const SPEND_ROUTES: readonly RegExp[] = [
  /^\/projects\/[^/]+\/generate$/,
  // 20.9 month plans: Claude writes the topics and generate makes every post.
  /^\/content-plans$/,
  /^\/content-plans\/[^/]+\/(generate|redraft)$/,
  /^\/content-plans\/[^/]+\/items\/[^/]+\/regenerate$/,
  /^\/projects\/[^/]+\/auto-populate$/,
  /^\/projects\/[^/]+\/auto-publish(\/retry)?$/,
  /^\/projects\/[^/]+\/caption-suggestions$/,
  /^\/projects\/[^/]+\/scripts$/,
  /^\/projects\/[^/]+\/slides$/,
  /^\/scripts\/[^/]+\/regenerate$/,
  /^\/shots\/[^/]+\/regenerate$/,
  /^\/renders\/[^/]+\/rerender$/,
  /^\/renders\/[^/]+\/preview$/,
  /^\/renders\/[^/]+\/overlays(\/bulk)?$/,
  /^\/overlays\/[^/]+\/preview$/,
  /^\/publications$/,
  /^\/publications\/[^/]+\/retry$/,
  /^\/businesses\/[^/]+\/scan-website$/,
  /^\/businesses\/[^/]+\/scans\/schedule$/,
  /^\/image-library\/(generate|refresh)$/,
  /^\/brand-kits\/extract$/,
  /^\/voice-profiles$/,
  /^\/voice-profiles\/[^/]+\/preview$/,
  /^\/uploads\/[^/]+\/complete$/,
];

const STUDIO_PREFIX = '/api/studio';

/** The path under /api/studio ("" for other paths). */
export function studioPath(pathname: string): string {
  return pathname.startsWith(STUDIO_PREFIX) ? pathname.slice(STUDIO_PREFIX.length) || '/' : '';
}

export type AccessDecision =
  { allowed: true } | { allowed: false; code: 'plan_required' | 'billing_required' };

/** Pure decision (tests cover the allowlist route by route). */
export function accessDecision(
  access: TenantAccess | undefined,
  method: string,
  pathname: string,
): AccessDecision {
  if (!access || access === 'full') return { allowed: true };
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return { allowed: true };
  const path = studioPath(pathname);
  if (access === 'none') {
    return SPEND_ROUTES.some((re) => re.test(path))
      ? { allowed: false, code: 'plan_required' }
      : { allowed: true };
  }
  if (m === 'DELETE') return { allowed: true };
  return READ_ONLY_ALLOWLIST.some((re) => re.test(path))
    ? { allowed: true }
    : { allowed: false, code: 'billing_required' };
}

export function assertAccess(
  tenant: Pick<TenantContext, 'access' | 'organisation'>,
  method: string,
  pathname: string,
): void {
  const decision = accessDecision(tenant.access, method, pathname);
  if (decision.allowed) return;
  const details = { access: tenant.access, planTier: tenant.organisation.planTier ?? null };
  if (decision.code === 'plan_required')
    throw new PlanRequiredError('Choose a plan to generate, publish or scan', details);
  throw new BillingRequiredError(
    'Your subscription needs attention: update the payment method to make changes',
    details,
  );
}

/** Apply entitlements to the tenant: tier, access. Pure. */
export function tenantWithEntitlements(tenant: TenantContext, ent: Entitlements): TenantContext {
  return {
    ...tenant,
    organisation: { ...tenant.organisation, planTier: ent.tier },
    access: ent.access,
  };
}

export interface BillingGateDeps {
  entitlements?: EntitlementsReader;
  modes?: Pick<StudioModes, 'billing'>;
  /** 14.11 beta: an organisation in an active "Plus for 30 days" beta has full access. */
  betaPlans?: BetaPlanLookup;
  now: () => number;
}

/**
 * route.ts hook: in Stripe billing mode, read the organisation's entitlements (30 s cache), set
 * the tenant's tier and access from them, then enforce the access gate. Without an entitlements
 * reader (tests, core mode) the tenant is returned unchanged; core mode keeps Core's tier with
 * access full (§P.3).
 */
export async function billingGate(
  deps: BillingGateDeps,
  req: Pick<Request, 'method' | 'url'>,
  tenant: TenantContext,
): Promise<TenantContext> {
  if (!deps.entitlements || deps.modes?.billing === 'core') return tenant;
  const ent = await deps.entitlements.forOrganisation(tenant.organisationId);
  const beta =
    ent.access !== 'full' && deps.betaPlans
      ? plusActive(await deps.betaPlans.find(tenant.organisationId), deps.now())
      : false;
  const next = tenantWithEntitlements(tenant, beta ? { ...ent, access: 'full' } : ent);
  assertAccess(next, req.method, new URL(req.url).pathname);
  return next;
}
