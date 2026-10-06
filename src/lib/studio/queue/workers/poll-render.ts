import type { PipelineDeps } from '../../pipeline/deps';
import { failProject } from '../../pipeline/project-state';
import { cancelPendingRenders, pollRenders, projectJobOf } from '../../pipeline/render-async';
import type { PollRenderJobData } from '../queues';

// BACKLOG 23.6 — finish a run's external renders (pipeline/render-async.ts): poll each pending
// render, store / master / record the finished ones, re-submit failed ones (compose-video retry)
// and hand the run to the quality gate once every variant is recorded. Delayed (BullMQ delayed
// job), re-added by itself while renders run, and promoted by the render callback route.

export async function pollRender(data: PollRenderJobData, deps: PipelineDeps): Promise<void> {
  const outcome = await pollRenders(data, deps);
  if (outcome && (outcome.recorded > 0 || outcome.failed > 0)) {
    deps.logger.info(
      {
        projectId: data.projectId,
        runId: data.runId,
        chain: data.chain,
        poll: data.poll,
        ...outcome,
      },
      'renders polled',
    );
  }
}

export async function onPollRenderFailed(
  data: PollRenderJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // The poll could not run (kill switch, repeated DB / storage failures): stop the run's renders
  // at the provider (their reservations are released) and fail the project like compose did.
  const job = projectJobOf(data);
  await cancelPendingRenders(deps, job);
  await failProject(deps.db, { ...job, reason: `composition_failed: ${reason}` });
}
