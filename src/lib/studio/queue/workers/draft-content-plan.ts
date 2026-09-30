import { draftPlan, draftPlanFailed, routedPlanGenerator } from '../../services/content-plan-draft';
import type { PipelineDeps } from '../../pipeline/deps';
import type { ContentPlanJobData } from '../queues';

// 20.9 — Claude writes a month plan's topics (services/content-plan-draft.ts). Runs as the plan's
// organisation, so the kill switch, billing access and the cost caps apply like any provider call.

export async function draftContentPlan(
  data: ContentPlanJobData,
  deps: PipelineDeps,
): Promise<void> {
  await draftPlan(
    {
      db: deps.db,
      logger: deps.logger,
      now: deps.now,
      generate: routedPlanGenerator(deps, {
        organisationId: data.organisationId,
        planTier: data.planTier,
      }),
    },
    data.planId,
    data.runId,
  );
}

/** Last attempt failed: the plan becomes an editable draft that says the topics are missing. */
export async function onDraftContentPlanFailed(
  data: ContentPlanJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ planId: data.planId, reason }, 'month plan draft failed');
  await draftPlanFailed(deps.db, data.planId, 'draft_failed');
}
