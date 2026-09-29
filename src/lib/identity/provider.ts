import type { TenantContext, TenantRequest } from '../tenant';

// Phase 18 §2.2 — where requireTenantContext and requireCapability get their data.
//   standalone: Better Auth session + local membership role + entitlements (identity/standalone.ts)
//   core:       PostMind Core's JWKS JWT + context endpoint, unchanged (identity/core.ts)

export type IdentityMode = 'standalone' | 'core';

export interface IdentityProvider {
  readonly mode: IdentityMode;
  /**
   * The tenant for this request. 401 (UnauthorizedError) without a valid session, 403
   * (ForbiddenError) without membership or on a cross-site cookie write. Never fails open.
   */
  resolve(req: TenantRequest): Promise<TenantContext>;
  /**
   * Drop cached contexts for a user (role change, ban, removal from an organisation). Core mode
   * has its own 5-minute cache and ignores this.
   */
  invalidate(userId: string): void;
}
