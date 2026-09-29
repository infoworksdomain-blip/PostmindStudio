import { StudioCapability as C, type StudioCapability } from '../rbac';
import type { PlatformRole } from '../tenant';

// Phase 18 §2.4 / §2.5 — standalone mode grants capabilities from the member's organisation role
// and the user's platform role. Core mode never reads this (Core grants capabilities itself).
// No organisation role ever gets a wildcard; only superadmin gets `studio:admin:*`, and staff
// capabilities need two-factor authentication.

export const ORG_ROLES = ['owner', 'admin', 'publisher', 'creator', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

const VIEWER: readonly StudioCapability[] = [C.ProjectRead];
const CREATOR: readonly StudioCapability[] = [C.ProjectRead, C.RenderDownload, C.ProjectWrite];
const PUBLISHER: readonly StudioCapability[] = [...CREATOR, C.ProjectApprove, C.PublicationWrite];
const ADMIN: readonly StudioCapability[] = [
  ...PUBLISHER,
  C.RenderForceApprove,
  C.ConnectionsManage,
  C.BusinessManage,
  C.MembersManage,
  C.OrgManage,
  C.AuditRead,
  C.BillingRead,
];
const OWNER: readonly StudioCapability[] = [...ADMIN, C.BillingManage, C.OrgDelete];

export const ROLE_CAPABILITIES: Readonly<Record<OrgRole, readonly StudioCapability[]>> = {
  owner: OWNER,
  admin: ADMIN,
  publisher: PUBLISHER,
  creator: CREATOR,
  viewer: VIEWER,
};

/** Capabilities for an organisation role. An unknown role (data from elsewhere) gets nothing. */
export function capabilitiesForRole(role: string): StudioCapability[] {
  return isOrgRole(role) ? [...ROLE_CAPABILITIES[role]] : [];
}

const STAFF: readonly string[] = [
  C.AdminKillSwitchRead,
  C.AdminProviders,
  C.AdminLibrary,
  C.AdminModeration,
];

/** Platform role from `users.role` (admin plugin). Anything unexpected is a plain user. */
export function toPlatformRole(value: string | null | undefined): PlatformRole {
  return value === 'staff' || value === 'superadmin' ? value : 'user';
}

/** Staff capabilities; none without two-factor authentication (§2.5). */
export function capabilitiesForPlatformRole(
  role: PlatformRole,
  twoFactorEnabled: boolean,
): string[] {
  if (!twoFactorEnabled) return [];
  if (role === 'superadmin') return ['studio:admin:*'];
  if (role === 'staff') return [...STAFF];
  return [];
}

/** The union for one member, without duplicates. */
export function capabilitiesFor(input: {
  orgRole: string;
  platformRole: PlatformRole;
  twoFactorEnabled: boolean;
}): string[] {
  return [
    ...new Set<string>([
      ...capabilitiesForRole(input.orgRole),
      ...capabilitiesForPlatformRole(input.platformRole, input.twoFactorEnabled),
    ]),
  ];
}
