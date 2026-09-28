import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createWorkflow,
  createWorkflowInput,
  listWorkflows,
  listWorkflowsQuery,
} from '@/lib/studio/services/approval-workflows';

// GET|POST /api/studio/approval-workflows (15.D3, spec 7.13). Listing needs only
// studio:project:read (the create screen's workflow picker, 15.C4; `?businessId=&platforms=`
// adds `matched`, the workflow such a project would get). Creating needs
// studio:project:approve plus an organisation owner/admin membership.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listWorkflowsQuery);
  return { body: await listWorkflows(deps.db, tenant.organisationId, query) };
});

export const POST = withStudioRoute(
  StudioCapability.ProjectApprove,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, createWorkflowInput);
    const workflow = await createWorkflow(deps.db, tenant, input);
    audit(
      'studio.approval_workflow.create',
      { type: 'approval_workflow', id: workflow.id },
      { steps: workflow.steps, appliesTo: workflow.appliesTo },
    );
    return { status: 201, body: { workflow } };
  },
);
