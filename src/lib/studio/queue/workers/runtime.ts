import { UnrecoverableError } from 'bullmq';
import {
  ConfigurationError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  NotFoundError,
  NotImplementedError,
  PlatformError,
  ProviderError,
  StudioError,
  ValidationError,
} from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import { retryDelayMs, type JobDataMap, type JobName } from '../queues';
import type { InlineJobQueue } from '../enqueue';
import { composeVideo, onComposeVideoFailed } from './compose-video';
import { generateAsset, onGenerateAssetFailed } from './generate-asset';
import { onPlanProjectFailed, planProject } from './plan-project';
import {
  fireScheduledPublication,
  onFireScheduledFailed,
  onPublishVideoFailed,
  publishVideo,
} from './publish-video';
import { onRunQualityGateFailed, runQualityGate } from './run-quality-gate';

// BACKLOG 3.8 / 3.9 — the wrapper every job runs through, on BullMQ or inline:
//   - kill switch checked on job start (global / workspace / project)
//   - errors classified: retryable ones retry (5 retries, 5s → 2min backoff); non-retryable
//     ones become UnrecoverableError so BullMQ doesn't waste retries
//   - on the final failed attempt the step's failure handler marks the shot/project FAILED
//   - failed jobs stay in BullMQ's failed set (dead-letter) for operator action

type Processor<N extends JobName> = (data: JobDataMap[N], deps: PipelineDeps) => Promise<void>;
type FailureHandler<N extends JobName> = (
  data: JobDataMap[N],
  deps: PipelineDeps,
  reason: string,
  err?: unknown,
) => Promise<void>;

export const PROCESSORS: { [N in JobName]: Processor<N> } = {
  'plan-project': planProject,
  'generate-asset': generateAsset,
  'compose-video': composeVideo,
  'run-quality-gate': runQualityGate,
  'publish-video': publishVideo,
  'fire-scheduled-publication': fireScheduledPublication,
};

export const FAILURE_HANDLERS: { [N in JobName]: FailureHandler<N> } = {
  'plan-project': onPlanProjectFailed,
  'generate-asset': onGenerateAssetFailed,
  'compose-video': onComposeVideoFailed,
  'run-quality-gate': onRunQualityGateFailed,
  'publish-video': onPublishVideoFailed,
  'fire-scheduled-publication': onFireScheduledFailed,
};

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError || err instanceof PlatformError) return err.retryable;
  // Breakers close and budgets reset; routing again later may succeed.
  if (err instanceof NoProviderAvailableError) return true;
  if (
    err instanceof KillSwitchTriggeredError ||
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof NotImplementedError ||
    err instanceof ConfigurationError
  ) {
    return false;
  }
  if (err instanceof StudioError) return false;
  return true; // unexpected errors (DB blips, network) are worth retrying
}

export function describeError(err: unknown): string {
  if (err instanceof KillSwitchTriggeredError) return `kill_switch_${err.level}: ${err.message}`;
  if (err instanceof ProviderError) return `${err.providerId}/${err.errorClass}: ${err.message}`;
  if (err instanceof PlatformError) return `${err.platform}/${err.errorClass}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export interface JobAttempt {
  /** Attempts already made before this one (BullMQ job.attemptsMade). */
  attemptsMade: number;
  maxAttempts: number;
}

export async function executeJob<N extends JobName>(
  name: N,
  data: JobDataMap[N],
  deps: PipelineDeps,
  attempt: JobAttempt,
): Promise<void> {
  const log = deps.logger.child({
    job: name,
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  try {
    await deps.killSwitch.assertNotKilled({
      organisationId: data.organisationId,
      projectId: data.projectId,
    });
    await PROCESSORS[name](data, deps);
  } catch (err) {
    const retryable = isRetryable(err);
    const final = !retryable || attempt.attemptsMade + 1 >= attempt.maxAttempts;
    log.warn({ err, retryable, final, attempt: attempt.attemptsMade + 1 }, 'job attempt failed');
    if (final) {
      try {
        await FAILURE_HANDLERS[name](data, deps, describeError(err), err);
      } catch (handlerErr) {
        log.error({ err: handlerErr }, 'failure handler itself failed');
      }
      if (!retryable) throw new UnrecoverableError(describeError(err));
    }
    throw err;
  }
}

/**
 * Run every queued job to completion in-process, honouring the same retry policy (with the
 * injected sleep). Used by integration tests and scripts/run-test-project.ts (GATE 3).
 */
export async function drainInline(
  queue: InlineJobQueue,
  deps: PipelineDeps,
  options: { maxAttempts?: number } = {},
): Promise<{ executed: number; failedJobs: string[] }> {
  const maxAttempts = options.maxAttempts ?? 6;
  let executed = 0;
  const failedJobs: string[] = [];
  for (let job = queue.take(); job; job = queue.take()) {
    for (let attemptsMade = 0; ; attemptsMade += 1) {
      executed += 1;
      try {
        await executeJob(job.name, job.data as never, deps, { attemptsMade, maxAttempts });
        break;
      } catch (err) {
        if (err instanceof UnrecoverableError || attemptsMade + 1 >= maxAttempts) {
          failedJobs.push(job.jobId ?? job.name);
          break;
        }
        await deps.sleep(retryDelayMs(attemptsMade + 1));
      }
    }
  }
  return { executed, failedJobs };
}
