import { NotFoundError, ProviderError, ValidationError } from '../../errors';
import type { KillSwitch } from '../kill-switch';
import type { CircuitBreaker } from './circuit-breaker';
import {
  CLIENT_SIDE_ERROR_CLASSES,
  type ProviderAdapter,
  type ProviderErrorClass,
  type ProviderPollResult,
  type ProviderRequest,
} from './interface';
import type { ProviderJobRepository } from './job-repository';

// BACKLOG 2.11. Workers never call adapters directly; they go through submitTracked() and
// pollTracked(), which:
//   - check the kill switch (global / workspace / project / provider) before every submit
//   - write a studio.provider_jobs row on submit, poll and completion
//   - roll cost into studio.provider_usage and the project's costActualPence
//   - feed the circuit breaker with provider-health outcomes

export interface TrackingDeps {
  repo: ProviderJobRepository;
  killSwitch: Pick<KillSwitch, 'assertNotKilled'>;
  breaker: CircuitBreaker;
  now?: () => number;
}

export interface TrackedSubmission {
  jobId: string; // studio.provider_jobs.id
  providerJobId: string;
  estimatedCostPence: number;
  estimatedReadyAt: Date;
}

function affectsProviderHealth(errorClass: ProviderErrorClass | string): boolean {
  return !CLIENT_SIDE_ERROR_CLASSES.has(errorClass as ProviderErrorClass);
}

function metadataCostPence(output: ProviderPollResult['output']): number | undefined {
  const metadata = output?.metadata;
  if (metadata && typeof metadata === 'object' && 'costPence' in metadata) {
    const cost = (metadata as { costPence: unknown }).costPence;
    if (typeof cost === 'number' && Number.isInteger(cost) && cost >= 0) return cost;
  }
  return undefined;
}

export async function submitTracked(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  deps: TrackingDeps,
): Promise<TrackedSubmission> {
  const now = deps.now ?? Date.now;
  await deps.killSwitch.assertNotKilled({
    organisationId: request.organisationId,
    projectId: request.projectId,
    providerId: adapter.providerId,
  });

  const job = await deps.repo.create({
    organisationId: request.organisationId,
    projectId: request.projectId,
    provider: adapter.providerId,
    operation: request.capability,
    requestBody: request,
  });

  try {
    const submitted = await adapter.submit(request);
    await deps.repo.markRunning(job.id, submitted.providerJobId, submitted.estimatedCostPence);
    return { jobId: job.id, ...submitted };
  } catch (err) {
    const errorClass = err instanceof ProviderError ? err.errorClass : 'unknown';
    const completedAt = new Date(now());
    await deps.repo.markFailed(job.id, {
      errorClass,
      errorMessage: err instanceof Error ? err.message : String(err),
      completedAt,
      durationMs: completedAt.getTime() - job.startedAt.getTime(),
      state: errorClass === 'timeout' ? 'TIMED_OUT' : 'FAILED',
    });
    await deps.repo.recordUsage({
      organisationId: request.organisationId,
      provider: adapter.providerId,
      day: completedAt,
      succeeded: false,
      costPence: 0,
      projectId: request.projectId,
    });
    if (affectsProviderHealth(errorClass)) deps.breaker.recordFailure(adapter.providerId);
    throw err;
  }
}

export async function pollTracked(
  adapter: ProviderAdapter,
  jobId: string,
  deps: TrackingDeps,
): Promise<ProviderPollResult> {
  const now = deps.now ?? Date.now;
  const job = await deps.repo.find(jobId);
  if (!job) throw new NotFoundError(`Provider job ${jobId} not found`);
  if (job.provider !== adapter.providerId) {
    throw new ValidationError(`Provider job ${jobId} belongs to ${job.provider}`);
  }
  if (job.state !== 'RUNNING' || !job.providerJobId) {
    throw new ValidationError(`Provider job ${jobId} is ${job.state}, not RUNNING`);
  }

  const result = await adapter.poll(job.providerJobId);
  if (result.state === 'running') return result;

  const completedAt = new Date(now());
  const durationMs = completedAt.getTime() - job.startedAt.getTime();

  if (result.state === 'succeeded') {
    const costPence = metadataCostPence(result.output) ?? job.costPence;
    await deps.repo.markSucceeded(job.id, {
      responseBody: result.output,
      costPence,
      completedAt,
      durationMs,
    });
    await deps.repo.recordUsage({
      organisationId: job.organisationId,
      provider: job.provider,
      day: completedAt,
      succeeded: true,
      costPence,
      projectId: job.projectId,
    });
    deps.breaker.recordSuccess(adapter.providerId);
    return result;
  }

  const errorClass = result.error?.class ?? 'unknown';
  await deps.repo.markFailed(job.id, {
    errorClass,
    errorMessage: result.error?.message ?? 'Provider reported failure without detail',
    completedAt,
    durationMs,
    state: errorClass === 'timeout' ? 'TIMED_OUT' : 'FAILED',
  });
  await deps.repo.recordUsage({
    organisationId: job.organisationId,
    provider: job.provider,
    day: completedAt,
    succeeded: false,
    costPence: 0,
    projectId: job.projectId,
  });
  if (affectsProviderHealth(errorClass)) deps.breaker.recordFailure(adapter.providerId);
  return result;
}

/** Cancel an in-flight job at the provider and record it as CANCELLED. */
export async function cancelTracked(
  adapter: ProviderAdapter,
  jobId: string,
  deps: Pick<TrackingDeps, 'repo' | 'now'>,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const job = await deps.repo.find(jobId);
  if (!job) throw new NotFoundError(`Provider job ${jobId} not found`);
  if (job.state !== 'RUNNING' || !job.providerJobId) return;
  await adapter.cancel(job.providerJobId);
  const completedAt = new Date(now());
  await deps.repo.markFailed(job.id, {
    errorClass: 'cancelled',
    errorMessage: 'Cancelled by Studio',
    completedAt,
    durationMs: completedAt.getTime() - job.startedAt.getTime(),
    state: 'CANCELLED',
  });
}
