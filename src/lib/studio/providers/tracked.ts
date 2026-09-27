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
import type { ProviderJobRecord, ProviderJobRepository } from './job-repository';

// BACKLOG 2.11. Workers never call adapters directly; they go through submitTracked() and
// pollTracked(), which:
//   - check the kill switch (global / workspace / project / provider) before every submit
//   - write a studio.provider_jobs row on submit, poll and completion
//   - RESERVE the estimated cost in provider_usage + video_projects.costActualPence at submit,
//     then SETTLE to the actual cost (or release it) at completion. Spend is therefore visible
//     to budget caps even if the worker dies before polling: synchronous providers have already
//     billed by the time submit() returns.
//   - feed the circuit breaker, and release a half-open trial slot whenever the trial request
//     never reached the provider
//   - scope poll/cancel to the caller's organisation (tenant isolation)

export interface TrackingDeps {
  repo: ProviderJobRepository;
  killSwitch: Pick<KillSwitch, 'assertNotKilled'>;
  breaker: CircuitBreaker;
  now?: () => number;
}

export interface TrackingScope {
  organisationId: string;
}

export interface TrackedSubmission {
  jobId: string; // studio.provider_jobs.id
  providerJobId: string;
  estimatedCostPence: number;
  estimatedReadyAt: Date;
}

const REDACTED_URL = '[redacted: temporary URL]';

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

/**
 * Provider outputs contain bearer-style URLs (S3 presigned, Runway/Shotstack CDN links) that
 * grant direct access to tenant assets. Stored responses keep bucket/key metadata only.
 */
export function redactUrls(value: unknown): unknown {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? REDACTED_URL : value;
  if (Array.isArray(value)) return value.map(redactUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactUrls(v)]));
  }
  return value;
}

/** Health signal for the breaker; a request that says nothing about health frees a trial. */
function reportOutcome(breaker: CircuitBreaker, providerId: string, errorClass: string): void {
  if (affectsProviderHealth(errorClass)) breaker.recordFailure(providerId);
  else breaker.releaseTrial(providerId);
}

export async function submitTracked(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  deps: TrackingDeps,
): Promise<TrackedSubmission> {
  const now = deps.now ?? Date.now;
  let job: ProviderJobRecord;
  try {
    await deps.killSwitch.assertNotKilled({
      organisationId: request.organisationId,
      projectId: request.projectId,
      providerId: adapter.providerId,
    });
    job = await deps.repo.create({
      organisationId: request.organisationId,
      projectId: request.projectId,
      provider: adapter.providerId,
      operation: request.capability,
      requestBody: request,
    });
  } catch (err) {
    // Nothing reached the provider: give back a half-open trial slot if the router claimed one.
    deps.breaker.releaseTrial(adapter.providerId);
    throw err;
  }

  let submitted;
  try {
    submitted = await adapter.submit(request);
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
      day: job.startedAt,
      jobs: 1,
      succeeded: 0,
      failed: 1,
      costDeltaPence: 0,
      projectId: request.projectId,
    });
    reportOutcome(deps.breaker, adapter.providerId, errorClass);
    throw err;
  }

  await deps.repo.markRunning(job.id, submitted.providerJobId, submitted.estimatedCostPence);
  // Reserve the estimate now; pollTracked settles it to the actual cost.
  await deps.repo.recordUsage({
    organisationId: request.organisationId,
    provider: adapter.providerId,
    day: job.startedAt,
    jobs: 1,
    succeeded: 0,
    failed: 0,
    costDeltaPence: submitted.estimatedCostPence,
    projectId: request.projectId,
  });
  return { jobId: job.id, ...submitted };
}

async function findScopedJob(
  adapter: ProviderAdapter,
  jobId: string,
  scope: TrackingScope,
  repo: ProviderJobRepository,
): Promise<ProviderJobRecord> {
  const job = await repo.find(jobId);
  // Another organisation's job is reported as not found, never as forbidden.
  if (!job || job.organisationId !== scope.organisationId) {
    throw new NotFoundError(`Provider job ${jobId} not found`);
  }
  if (job.provider !== adapter.providerId) {
    throw new ValidationError(`Provider job ${jobId} belongs to ${job.provider}`);
  }
  return job;
}

export async function pollTracked(
  adapter: ProviderAdapter,
  jobId: string,
  scope: TrackingScope,
  deps: TrackingDeps,
): Promise<ProviderPollResult> {
  const now = deps.now ?? Date.now;
  const job = await findScopedJob(adapter, jobId, scope, deps.repo);
  if (job.state !== 'RUNNING' || !job.providerJobId) {
    throw new ValidationError(`Provider job ${jobId} is ${job.state}, not RUNNING`);
  }

  const result = await adapter.poll(job.providerJobId);
  if (result.state === 'running') return result;

  const completedAt = new Date(now());
  const durationMs = completedAt.getTime() - job.startedAt.getTime();
  const reserved = job.costPence;
  const usageBase = {
    organisationId: job.organisationId,
    provider: job.provider,
    day: job.startedAt,
    jobs: 0 as const,
    projectId: job.projectId,
  };

  if (result.state === 'succeeded') {
    const costPence = metadataCostPence(result.output) ?? reserved;
    await deps.repo.markSucceeded(job.id, {
      responseBody: redactUrls(result.output),
      costPence,
      completedAt,
      durationMs,
    });
    await deps.repo.recordUsage({
      ...usageBase,
      succeeded: 1,
      failed: 0,
      costDeltaPence: costPence - reserved,
    });
    deps.breaker.recordSuccess(adapter.providerId);
    return result;
  }

  const errorClass = result.error?.class ?? 'unknown';
  // Some providers still bill failed work and say so (e.g. Runway FAILED carries cost.credits).
  const chargedPence = metadataCostPence(result.output) ?? 0;
  await deps.repo.markFailed(job.id, {
    errorClass,
    errorMessage: result.error?.message ?? 'Provider reported failure without detail',
    completedAt,
    durationMs,
    costPence: chargedPence,
    state: errorClass === 'timeout' ? 'TIMED_OUT' : 'FAILED',
  });
  await deps.repo.recordUsage({
    ...usageBase,
    succeeded: 0,
    failed: 1,
    costDeltaPence: chargedPence - reserved,
  });
  reportOutcome(deps.breaker, adapter.providerId, errorClass);
  return result;
}

/** Cancel an in-flight job at the provider, record it CANCELLED and release its reservation. */
export async function cancelTracked(
  adapter: ProviderAdapter,
  jobId: string,
  scope: TrackingScope,
  deps: Pick<TrackingDeps, 'repo' | 'now'>,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const job = await findScopedJob(adapter, jobId, scope, deps.repo);
  if (job.state !== 'RUNNING' || !job.providerJobId) return;
  const reserved = job.costPence; // read before the row is updated
  await adapter.cancel(job.providerJobId);
  const completedAt = new Date(now());
  await deps.repo.markFailed(job.id, {
    errorClass: 'cancelled',
    errorMessage: 'Cancelled by Studio',
    completedAt,
    durationMs: completedAt.getTime() - job.startedAt.getTime(),
    costPence: 0,
    state: 'CANCELLED',
  });
  await deps.repo.recordUsage({
    organisationId: job.organisationId,
    provider: job.provider,
    day: job.startedAt,
    jobs: 0,
    succeeded: 0,
    failed: 1,
    costDeltaPence: -reserved,
    projectId: job.projectId,
  });
}
