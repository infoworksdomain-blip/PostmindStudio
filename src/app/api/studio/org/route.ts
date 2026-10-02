import { invalidateIdentity } from '@/lib/identity';
import { AuditAction } from '@/lib/audit-sink';
import { reauthenticateRequest } from '@/lib/auth/reauth';
import { studioModes } from '@/lib/mode';
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
//   DELETE  studio:org:delete (owner): { confirmName, password? } — re-authenticates (§5.11: the
//           password, or a sign-in in the last 15 minutes for Google-only accounts; standalone
//           mode), cancels billing, soft-deletes and starts the existing 30-day purge. Audited.
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
    const { confirmName, password } = await parseBody(req, deleteOrganisationInput);
    if ((deps.modes ?? studioModes()).identity === 'standalone')
      await reauthenticateRequest(req, password);
    const memberUserIds = (
      await deps.db.member.findMany({
        where: { organizationId: tenant.organisationId },
        select: { userId: true },
      })
    ).map((m) => m.userId);
    const purge = await deleteOrganisation(deps, tenant, confirmName);
    // Everyone loses access at once: tenant contexts are cached for 30 s per process, so drop the
    // members' entries (the store no longer lists a deleted organisation).
    for (const userId of memberUserIds) await invalidateIdentity(userId, deps.identity);
    audit(
      AuditAction.OrgDeleted,
      { type: 'organisation', id: tenant.organisationId },
      { graceUntil: purge.graceUntil },
    );
    return { body: { deleted: true, graceUntil: purge.graceUntil } };
  },
);
