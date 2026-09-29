import { ForbiddenError } from './errors';
import type { TenantContext } from './tenant';

// Integration point 3 (Engagement handover 7.4). Call immediately after requireTenantContext.
// Capabilities are granted by PostMind Core; Studio only enforces them.

export const StudioCapability = {
  ProjectRead: 'studio:project:read',
  ProjectWrite: 'studio:project:write',
  /** Approve / reject for publication — separate from editing so creators can't self-approve. */
  ProjectApprove: 'studio:project:approve',
  RenderDownload: 'studio:render:download', // spec 8.4
  /** Publish to / take down from connected social accounts. */
  PublicationWrite: 'studio:publication:write',
  /** Connect / disconnect TikTok, YouTube, X, LinkedIn accounts. */
  ConnectionsManage: 'studio:connections:manage',
  RenderForceApprove: 'studio:render:force-approve', // spec 13.5
  AdminKillSwitchRead: 'studio:admin:kill-switch:read',
  AdminKillSwitchWrite: 'studio:admin:kill-switch:write',
  AdminProviders: 'studio:admin:providers',
  AdminLibrary: 'studio:admin:library',
  AdminModeration: 'studio:admin:moderation',
  /** Bulk re-drive of kill-switched / stuck work (POST /admin/redrive). Spends provider money. */
  AdminRedrive: 'studio:admin:redrive',
  // Phase 18 §2.4 — organisation-level capabilities (standalone mode grants them from the
  // member's role; core mode from Core).
  /** Rename the organisation, logo, default locale, transfer ownership. */
  OrgManage: 'studio:org:manage',
  /** Delete the organisation (owner only). */
  OrgDelete: 'studio:org:delete',
  /** Invite, change role and remove members. */
  MembersManage: 'studio:members:manage',
  BillingRead: 'studio:billing:read',
  /** Checkout, portal, plan change, top-ups (owner only). */
  BillingManage: 'studio:billing:manage',
  /** Create, rename and delete businesses. */
  BusinessManage: 'studio:business:manage',
  /** The organisation's audit log (/settings/audit). */
  AuditRead: 'studio:audit:read',
  // Phase 18 §2.5 — platform staff (superadmin) capabilities.
  AdminOrganisations: 'studio:admin:organisations',
  AdminUsers: 'studio:admin:users',
  AdminBilling: 'studio:admin:billing',
  AdminImpersonate: 'studio:admin:impersonate',
} as const;

export type StudioCapability = (typeof StudioCapability)[keyof typeof StudioCapability];

/**
 * True when `granted` covers `required`. A grant ending in `:*` covers everything beneath
 * its prefix (`studio:admin:*` covers `studio:admin:kill-switch:write`). No other wildcards.
 */
export function capabilityMatches(granted: string, required: StudioCapability): boolean {
  if (granted === required) return true;
  if (!granted.endsWith(':*')) return false;
  return required.startsWith(granted.slice(0, -1));
}

export function hasCapability(
  context: Pick<TenantContext, 'capabilities'>,
  capability: StudioCapability,
): boolean {
  return context.capabilities.some((granted) => capabilityMatches(granted, capability));
}

/**
 * Defence in depth for staff-only (admin) endpoints: besides the studio:admin:* capability from
 * Core, the caller's organisation must be one of STUDIO_PLATFORM_ORG_IDS (PostMind's own staff
 * organisations). Unset: allowed outside production, refused in production.
 */
export function requirePlatformStaff(
  context: Pick<TenantContext, 'organisationId'> &
    Partial<Pick<TenantContext, 'platformRole' | 'capabilities'>>,
  env: Record<string, string | undefined> = process.env,
): void {
  // Phase 18 §2.5 standalone mode (the standalone identity provider always sets platformRole;
  // core mode never does): staff are users with users.role staff | superadmin AND two-factor
  // authentication (studio:admin:* capabilities are only granted then). The organisation-id list
  // below stays core mode's rule, unchanged.
  if (context.platformRole !== undefined) {
    const isStaff = context.platformRole === 'staff' || context.platformRole === 'superadmin';
    const verified = (context.capabilities ?? []).some((c) => c.startsWith('studio:admin:'));
    if (!isStaff) throw new ForbiddenError('Admin endpoints are for PostMind Studio staff only');
    if (!verified) {
      throw new ForbiddenError('Staff must turn on two-factor authentication to use admin tools', {
        reason: 'two_factor_required',
      });
    }
    return;
  }
  const allowed = (env.STUDIO_PLATFORM_ORG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    if (env.NODE_ENV === 'production') {
      throw new ForbiddenError('Admin endpoints are disabled: STUDIO_PLATFORM_ORG_IDS is not set');
    }
    return;
  }
  if (!allowed.includes(context.organisationId)) {
    throw new ForbiddenError('Admin endpoints are for PostMind staff organisations only');
  }
}

export function requireCapability(
  context: Pick<TenantContext, 'capabilities'>,
  capability: StudioCapability,
): void {
  if (!hasCapability(context, capability)) {
    throw new ForbiddenError(`Missing capability ${capability}`, { capability });
  }
}
