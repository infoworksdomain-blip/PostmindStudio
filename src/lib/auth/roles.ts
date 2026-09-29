import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc as platformAdminAc,
  defaultStatements as platformStatements,
  userAc as platformUserAc,
} from 'better-auth/plugins/admin/access';
import {
  adminAc as orgAdminAc,
  defaultStatements as orgStatements,
  memberAc as orgMemberAc,
  ownerAc as orgOwnerAc,
} from 'better-auth/plugins/organization/access';

// Phase 18 §2.4 / §2.5 — the roles Better Auth's own endpoints enforce (organization plugin:
// invite / remove / update members and organisation; admin plugin: user management). Studio's
// /api/studio capabilities come from identity/role-capabilities.ts, not from here.
// Pattern from https://www.better-auth.com/docs/plugins/organization#access-control and
// https://www.better-auth.com/docs/plugins/admin#access-control (read 2026-09-29): an access
// controller over the default statements, roles built with newRole from the default role grants.

export const organisationAccessControl = createAccessControl(orgStatements);

/** owner and admin manage the organisation; publisher / creator / viewer manage nothing. */
export const organisationRoles = {
  owner: organisationAccessControl.newRole(orgOwnerAc.statements),
  admin: organisationAccessControl.newRole(orgAdminAc.statements),
  publisher: organisationAccessControl.newRole(orgMemberAc.statements),
  creator: organisationAccessControl.newRole(orgMemberAc.statements),
  viewer: organisationAccessControl.newRole(orgMemberAc.statements),
};

export const platformAccessControl = createAccessControl(platformStatements);

/** Only superadmin may call Better Auth's /admin/* endpoints; staff act through Studio's APIs. */
export const platformRoles = {
  user: platformAccessControl.newRole(platformUserAc.statements),
  staff: platformAccessControl.newRole(platformUserAc.statements),
  superadmin: platformAccessControl.newRole(platformAdminAc.statements),
};

export const PLATFORM_ADMIN_ROLES = ['superadmin'];
