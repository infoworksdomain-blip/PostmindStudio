import { AuditAction } from '@/lib/audit-sink';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  deleteOrganisation,
  deleteOrganisationInput,
  getOrganisationSettings,
  updateOrganisationInput,
  updateOrganisationSettings,
} from '@/lib/studio/services/org-settings';

// /api/studio/org (Phase 18 §3 /settings/organisation) — the caller's active organisation.
//   GET     any member
//   PATCH   studio:org:manage (owner, admin): name, logo, country, default locale
//   DELETE  studio:org:delete (owner): { confirmName } — cancels billing, soft-deletes and starts
//           the existing 30-day purge. Audited.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps, tenant }) => ({
  body: { organisation: await getOrganisationSettings(deps.db, tenant) },
}));

export const PATCH = withStudioRoute(
  StudioCapability.OrgManage,
  async ({ req, deps, tenant, audit }) => {
    const input = await parseBody(req, updateOrganisationInput);
    const organisation = await updateOrganisationSettings(
      deps.db,
      tenant,
      input,
      (action, metadata) =>
        audit(action, { type: 'organisation', id: tenant.organisationId }, metadata),
    );
    return { body: { organisation } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.OrgDelete,
  async ({ req, deps, tenant, audit }) => {
    const { confirmName } = await parseBody(req, deleteOrganisationInput);
    const purge = await deleteOrganisation(deps, tenant, confirmName);
    audit(
      AuditAction.OrgDeleted,
      { type: 'organisation', id: tenant.organisationId },
      { graceUntil: purge.graceUntil },
    );
    return { body: { deleted: true, graceUntil: purge.graceUntil } };
  },
);
