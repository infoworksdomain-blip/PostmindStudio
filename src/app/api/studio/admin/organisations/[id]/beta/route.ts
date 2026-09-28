import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { betaCohortInput, getBeta, putBeta } from '@/lib/studio/services/beta';

// BACKLOG 14.11 — an organisation's beta cohort (PostMind staff, studio:admin:providers: the
// Plus override changes routing and cost caps). GET → { organisationId, beta | null }.
// PUT { cohort, plusUntil? } enrols or updates; plusUntil omitted on enrolment = now + 30 days
// (playbook 10.4 "Plus for 30 days"), null = no Plus override. While plusUntil is in the future
// the organisation's effective plan tier is at least PLUS (services/beta.ts). Audited.
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    return { body: await getBeta(deps.db, params.id ?? '', deps.now()) };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, betaCohortInput);
    const { before, after } = await putBeta(
      deps.db,
      params.id ?? '',
      input,
      tenant.userId,
      deps.now(),
    );
    deps.betaPlans?.invalidate(after.organisationId);
    audit(
      'studio.admin.beta.update',
      { type: 'organisation', id: after.organisationId },
      {
        before: before && { cohort: before.cohort, plusUntil: before.plusUntil },
        after: { cohort: after.cohort, plusUntil: after.plusUntil },
      },
    );
    return { body: { organisationId: after.organisationId, beta: after } };
  },
);
