import type { TenantContext } from '../../tenant';

// 21.5 / 22.5: provider costs are for PostMind staff only (the app's useShowCosts is the client
// half). Customers never see or set pence amounts (automation estimates, cost ceilings).
export function isCostViewer(tenant: Pick<TenantContext, 'platformRole'>): boolean {
  return tenant.platformRole === 'staff' || tenant.platformRole === 'superadmin';
}
