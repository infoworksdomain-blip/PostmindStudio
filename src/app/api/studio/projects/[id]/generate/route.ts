import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  checkGenerateQuota,
  notifyQuotaThresholds,
  releaseQuotaReservation,
} from '@/lib/studio/services/plan-quotas';
import { generateInput, generateProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/generate — start the pipeline; returns immediately (poll state)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, generateInput);
    const id = params.id ?? '';
    // Decision P3: spec 12.4 plan quotas (403 quota_exceeded in enforce mode; alerts either way).
    // Phase 18: with entitlements the check is locked per (org, month), reserves the slot and may
    // spend a top-up credit; both are given back when the run does not start.
    const quota = await checkGenerateQuota(deps, tenant, id);
    let run: Awaited<ReturnType<typeof generateProject>>;
    try {
      run = await generateProject(deps, tenant, id, input);
    } catch (err) {
      await releaseQuotaReservation(deps, quota.reservation);
      throw err;
    }
    await notifyQuotaThresholds(deps, tenant);
    audit(
      'studio.project.generate',
      { type: 'video_project', id },
      {
        runId: run.runId,
        planTier: run.planTier,
        // 20.18: a direction chosen after ideation found the brief too vague.
        ...(input.directionChosen && { directionChosen: true }),
      },
    );
    return { status: 202, body: { projectId: id, state: 'QUEUED', ...run } };
  },
);
