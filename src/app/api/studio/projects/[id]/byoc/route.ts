import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { byocModeInput, setProjectByocMode } from '@/lib/studio/services/provider-credentials';

// P1 BYOC per-project override. PUT /api/studio/projects/:id/byoc { mode: 'org' | 'platform' }
// → { projectId, byoc }. 'platform' makes this project's provider calls use Studio's keys even
// when the organisation has its own; 'org' (the default) uses the organisation's keys.
export const PUT = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const { mode } = await parseBody(req, byocModeInput);
    const result = await setProjectByocMode({ db: deps.db }, tenant, id, mode);
    audit('studio.byoc.project_mode', { type: 'video_project', id }, { mode });
    return { body: result };
  },
);
