import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { checkGenerateQuota, notifyQuotaThresholds } from '@/lib/studio/services/plan-quotas';
import { generateInput, generateProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/generate — start the pipeline; returns immediately (poll state)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, generateInput);
    const id = params.id ?? '';
    // Decision P3: spec 12.4 plan quotas (403 quota_exceeded in enforce mode; alerts either way).
    await checkGenerateQuota(deps, tenant, id);
    const run = await generateProject(deps, tenant, id, input);
    await notifyQuotaThresholds(deps, tenant);
    audit(
      'studio.project.generate',
      { type: 'video_project', id },
      { runId: run.runId, planTier: run.planTier },
    );
    return { status: 202, body: { projectId: id, state: 'QUEUED', ...run } };
  },
);
