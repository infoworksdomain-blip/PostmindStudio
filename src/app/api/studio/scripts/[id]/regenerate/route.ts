import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { regenerateScript, regenerateScriptInput } from '@/lib/studio/services/scripts';

// POST /api/studio/scripts/:id/regenerate — new run from Layer 2 reusing the Layer 1 brief
// (13.1, spec 8.4). The instruction is the owner's steer for the rewrite.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const input = await parseBody(req, regenerateScriptInput);
    const result = await regenerateScript(deps, tenant, id, input);
    audit(
      'studio.script.regenerate',
      { type: 'video_script', id },
      {
        projectId: result.project.id,
        runId: result.runId,
        instruction: Boolean(input.instruction),
      },
    );
    return { status: 202, body: result };
  },
);
