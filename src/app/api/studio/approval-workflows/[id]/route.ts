import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  deleteWorkflow,
  getWorkflow,
  parseWorkflowId,
  updateWorkflow,
  updateWorkflowInput,
} from '@/lib/studio/services/approval-workflows';

// GET|PATCH|DELETE /api/studio/approval-workflows/:id (15.D3). Changes apply to review rounds
// that start afterwards; a project part-way through keeps the steps it started with.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      workflow: await getWorkflow(deps.db, tenant.organisationId, parseWorkflowId(params.id)),
    },
  }),
);

export const PATCH = withStudioRoute(
  StudioCapability.ProjectApprove,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateWorkflowInput);
    const workflow = await updateWorkflow(deps.db, tenant, parseWorkflowId(params.id), input);
    audit(
      'studio.approval_workflow.update',
      { type: 'approval_workflow', id: workflow.id },
      { fields: Object.keys(input), steps: workflow.steps, appliesTo: workflow.appliesTo },
    );
    return { body: { workflow } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectApprove,
  async ({ tenant, deps, params, audit }) => {
    const id = parseWorkflowId(params.id);
    await deleteWorkflow(deps.db, tenant, id);
    audit('studio.approval_workflow.delete', { type: 'approval_workflow', id });
    return { body: { deleted: true } };
  },
);
