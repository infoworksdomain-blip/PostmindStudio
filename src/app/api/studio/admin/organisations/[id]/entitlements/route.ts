import { AuditAction } from '@/lib/audit-sink';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  adminEntitlementClearInput,
  adminEntitlementInput,
  clearAdminEntitlements,
  getAdminEntitlements,
  putAdminEntitlements,
} from '@/lib/studio/billing/admin';

// Phase 18 §P.3 / §P.4 — staff entitlement overrides (studio:admin:billing + platform staff).
// GET  → effective entitlements, the stored row, the override, subscriptions, and the ENTERPRISE
//        minimum monthly price for the organisation's monthly cost cap.
// PUT  { tier?, access?, limits?, monthlyPricePence?, expiresAt?, reason } → the new view.
//      ENTERPRISE needs monthlyPricePence ≥ the minimum (422 unprocessable, below_minimum_price).
// DELETE { reason } → the override removed (the Stripe-derived value applies again).
// Every change is audited (entitlement.override_set) with before / after and the reason; the
// cache is invalidated in this process, other processes follow within 30 s.
export const GET = withStudioRoute(
  StudioCapability.AdminBilling,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    return {
      body: {
        entitlements: await getAdminEntitlements(deps.db, params.id ?? '', new Date(deps.now())),
      },
    };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminBilling,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, adminEntitlementInput);
    const { before, after } = await putAdminEntitlements(
      deps.db,
      params.id ?? '',
      input,
      tenant.userId,
      new Date(deps.now()),
    );
    audit(
      AuditAction.EntitlementOverrideSet,
      { type: 'organisation', id: after.organisationId },
      {
        before: { tier: before.tier, access: before.access, source: before.source },
        after: { tier: after.effective.tier, access: after.effective.access },
        limits: input.limits ?? null,
        monthlyPricePence: input.monthlyPricePence ?? null,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason,
      },
    );
    return { body: { entitlements: after } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.AdminBilling,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, adminEntitlementClearInput);
    const { before, after } = await clearAdminEntitlements(
      deps.db,
      params.id ?? '',
      input.reason,
      tenant.userId,
      new Date(deps.now()),
    );
    audit(
      AuditAction.EntitlementOverrideSet,
      { type: 'organisation', id: after.organisationId },
      {
        cleared: true,
        before: { tier: before.tier, access: before.access, source: before.source },
        after: { tier: after.effective.tier, access: after.effective.access },
        reason: input.reason,
      },
    );
    return { body: { entitlements: after } };
  },
);
