import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { publishOnApproval } from '@/lib/studio/automation/auto-publish';
import { approveInput, approveProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/approve — approve renders for publication. Projects with
// publishPolicy AUTO_ON_APPROVAL then publish to their stored targets (the response carries the
// per-target outcome; failures never undo the approval).
export const POST = withStudioRoute(
  StudioCapability.ProjectApprove,
  async ({ req, tenant, deps, params, audit }) => {
    const { note } = await parseBody(req, approveInput);
    const approved = await approveProject(deps.db, tenant, params.id ?? '', note, deps.now());
    audit('studio.project.approve', { type: 'video_project', id: approved.id });
    const autoPublish = await publishOnApproval(deps, {
      projectId: approved.id,
      organisationId: tenant.organisationId,
      planTier: tenant.organisation.planTier ?? '',
      trigger: 'human',
    });
    // `project` is the approval itself (APPROVED); what auto-publish did is in `autoPublish`.
    return { body: { project: approved, autoPublish } };
  },
);
