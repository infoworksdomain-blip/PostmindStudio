import type { Prisma } from '@prisma/client';
import { ConflictError, NotImplementedError, ProviderError } from '../../errors';
import type { AspectRatio, ProviderAdapter, ProviderPollResult } from '../providers/interface';
import { cancelTracked, pollTracked } from '../providers/tracked';
import { providerOutputKey } from '../storage';
import { jobIds } from '../queue/enqueue';
import {
  MAX_RETRIES,
  retryDelayMs,
  type PollRenderJobData,
  type ProjectJobData,
} from '../queue/queues';
import { describeError, isRetryable } from '../queue/workers/job-errors';
import type { PlanTier } from '../providers/router';
import type { PipelineDeps } from './deps';
import { fallbackFrom, type FallbackNotice } from './fallback-notice';
import { masterStoredRender } from './mastering';
import { copyUrlToStorage } from './persist';
import {
  currentRunId,
  failProject,
  mergeProjectMetadata,
  recordRunRender,
  transitionProject,
} from './project-state';
import {
  pollIntervalMs,
  recordProviderSpend,
  releaseSubmissionSlot,
  submitProvider,
} from './provider-run';
import {
  appendRunList,
  claimRenderPoll,
  COMPOSE_RETRIES_KEY,
  composeRetriesOf,
  deleteRunEntry,
  MASTERING_KEY,
  PENDING_RENDERS_KEY,
  pendingRendersOf,
  releaseRenderPoll,
  RENDER_POLL_NEXT_KEY,
  renderPointersOf,
  setRunEntry,
  type PendingRender,
} from './render-state';

// BACKLOG 23.6 — renders no longer hold a queue slot while the composer works (Shotstack p50 49 s).
//
//   compose-video (render lane)   builds every variant's edit, SUBMITS each render (tracked: the
//                                 cost estimate is reserved), records it in metadata.pendingRenders
//                                 and schedules a delayed poll-render; the job then ends.
//   poll-render   (render lane)   claims the run (one poller at a time), polls each pending render
//                                 (pollTracked settles the cost exactly once), stores, masters and
//                                 records every finished one as soon as it is seen (one transaction
//                                 per render), and either schedules the next poll, re-submits failed
//                                 variants (compose-video again, with the 3.9 backoff, ≤ 5 times),
//                                 or — once every variant is recorded — moves the run to the
//                                 quality gate exactly once (compare-and-set on the project state).
//   render callback (web)         promotes the delayed poll (Shotstack's callback, 23.1), so a
//                                 finished render is picked up at once; without a callback the
//                                 chain polls every 20 s (callback providers) or 5 s (others).
//
// Multi-format: every variant is submitted at once and each is recorded when it finishes; the run
// goes to the quality gate when all are recorded (the gate checks the whole run, as before).
// Timeouts are unchanged (providerTimeoutMs from the submit; the render is cancelled at the
// provider and counts as a failure). A renderer that returns the file at once (a local renderer)
// skips all of this: compose-video calls finishRender directly.

/** A poll claim outlives the slowest finish (download + mastering of several variants). */
export const POLL_CLAIM_MS = 10 * 60_000;

/** Thrown inside a render transaction to roll it back when the run was superseded. */
export class StaleRunError extends ConflictError {
  constructor() {
    super('Run superseded');
  }
}

/** The project job of a poll (no chain fields), for compose retries and the quality gate. */
export function projectJobOf(data: ProjectJobData): ProjectJobData {
  return {
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
    planTier: data.planTier,
    ...(data.batch && { batch: data.batch }),
  };
}

async function adapterFor(
  deps: PipelineDeps,
  data: ProjectJobData,
  providerId: string,
): Promise<ProviderAdapter | undefined> {
  const own = await deps.registryFor?.({
    organisationId: data.organisationId,
    projectId: data.projectId,
  });
  return own?.findAdapter(providerId) ?? deps.registry.findAdapter(providerId);
}

// ------------------------------------------------------------------ submit (compose-video)

export interface RenderVariant {
  scriptId: string;
  targetPlatform: string;
  aspectRatio: AspectRatio;
  edit: Record<string, unknown>;
  outputDurationSec: number;
  composition: Prisma.JsonValue;
}

/** Submit one variant to the composer and record it as pending. False = the run moved on. */
export async function submitRender(
  deps: PipelineDeps,
  data: ProjectJobData,
  variant: RenderVariant,
): Promise<boolean> {
  const submission = await submitProvider(
    {
      need: { kind: 'capability', capability: 'composition' },
      planTier: data.planTier,
      request: {
        capability: 'composition',
        organisationId: data.organisationId,
        projectId: data.projectId,
        edit: variant.edit,
        outputDurationSec: variant.outputDurationSec,
      },
    },
    deps,
  );
  const now = deps.now();
  const pending: PendingRender = {
    providerId: submission.decision.providerId,
    providerJobRowId: submission.providerJobRowId,
    providerJobId: submission.providerJobId,
    submittedAt: new Date(now).toISOString(),
    giveUpAt: new Date(now + deps.config.providerTimeoutMs).toISOString(),
    targetPlatform: variant.targetPlatform,
    aspectRatio: variant.aspectRatio,
    composition: variant.composition,
    ...(submission.lease && { lease: submission.lease }),
    // 15.B9: the same notice compose-video recorded before 23.6.
    fallback: fallbackFrom(submission.decision, 'composition'),
    planTier: data.planTier,
    ...(data.batch && { batch: true }),
  };
  return setRunEntry(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    key: PENDING_RENDERS_KEY,
    entryKey: variant.scriptId,
    value: pending,
  });
}

/** Schedule the next delayed poll of the run (and remember its id for callback promotion). */
export async function schedulePoll(
  deps: PipelineDeps,
  data: ProjectJobData,
  chain: string,
  poll: number,
  delayMs: number,
): Promise<void> {
  const job: PollRenderJobData = { ...projectJobOf(data), chain, poll };
  const jobId = jobIds.pollRender(data, `${chain}-${poll}`);
  await mergeProjectMetadata(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    patch: { [RENDER_POLL_NEXT_KEY]: jobId },
  });
  await deps.queue.add('poll-render', job, { jobId, delayMs });
}

/** How long to wait before the next poll: the fastest cadence among the pending providers. */
export async function nextPollDelayMs(
  deps: PipelineDeps,
  data: ProjectJobData,
  pending: readonly PendingRender[],
): Promise<number> {
  let delay = deps.config.providerPollIntervalMs;
  let first = true;
  for (const entry of pending) {
    const adapter = await adapterFor(deps, data, entry.providerId);
    const own = adapter ? pollIntervalMs(adapter, deps) : deps.config.providerPollIntervalMs;
    delay = first ? own : Math.min(delay, own);
    first = false;
  }
  return delay;
}

// ------------------------------------------------------------------ finish (both paths)

export interface FinishedRender {
  scriptId: string;
  targetPlatform: string;
  aspectRatio: string;
  composition: Prisma.JsonValue;
  /** Where the finished MP4 can be downloaded (a provider URL or a stored object's URL). */
  url: string;
  providerId: string;
  /** The tracked provider job (its settled cost goes on the render row); null for local renders. */
  providerJobRowId: string | null;
  composerJobId: string | null;
  fallback?: FallbackNotice | null;
}

/**
 * Layer 6/7 post-render steps, shared by the asynchronous path (poll-render) and any renderer that
 * returns the file at once: copy into the renders bucket, master (13.26), probe, then the render
 * row, its metadata.renders pointer, its mastering report and the removal of its pending entry in
 * ONE transaction (a retry either sees the pointer or finds none of it). StaleRunError when the
 * run was superseded.
 */
export async function finishRender(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: FinishedRender,
): Promise<string> {
  const stored = await copyUrlToStorage(
    deps.storage,
    {
      url: render.url,
      bucket: deps.config.rendersBucket,
      key: providerOutputKey({
        organisationId: data.organisationId,
        projectId: data.projectId,
        providerId: render.providerId,
        extension: 'mp4',
      }),
      fallbackContentType: 'video/mp4',
      providerId: render.providerId,
    },
    deps.fetch,
  );
  const mastered = await masterStoredRender(deps, {
    stored,
    probe: await deps.media.probe(stored.url),
    organisationId: data.organisationId,
    projectId: data.projectId,
  });
  const probe = mastered.probe;
  const job = render.providerJobRowId
    ? await deps.db.providerJob.findUnique({
        where: { id: render.providerJobRowId },
        select: { costPence: true },
      })
    : null;
  const created = await deps.db.$transaction(async (tx) => {
    const row = await tx.videoRender.create({
      data: {
        projectId: data.projectId,
        scriptId: render.scriptId,
        targetPlatform: render.targetPlatform,
        aspectRatio: render.aspectRatio,
        resolution: `${probe.width}x${probe.height}`,
        durationSec: probe.durationSec,
        fps: Math.round(probe.fps),
        bitrateKbps: probe.bitRateKbps,
        s3Bucket: mastered.stored.bucket,
        s3Key: mastered.stored.key,
        composerJobId: render.composerJobId,
        qualityCheckState: 'PENDING',
        costPence: job?.costPence ?? 0,
        composition: (render.composition ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    const run = { projectId: data.projectId, runId: data.runId };
    if (!(await recordRunRender(tx, { ...run, scriptId: render.scriptId, renderId: row.id })))
      throw new StaleRunError();
    await setRunEntry(tx, {
      ...run,
      key: MASTERING_KEY,
      entryKey: render.scriptId,
      value: mastered.report,
    });
    await deleteRunEntry(tx, { ...run, key: PENDING_RENDERS_KEY, entryKey: render.scriptId });
    return row;
  });
  if (render.fallback) {
    await appendRunList(deps.db, {
      projectId: data.projectId,
      runId: data.runId,
      key: 'fallbacks',
      items: [render.fallback],
    });
  }
  return created.id;
}

/**
 * Every variant of the run has a render: 13.1 / 13.2 staleRenders cleared, then RENDERING →
 * QUALITY_CHECKING (compare-and-set, so only one finisher enqueues the gate and thumbnails).
 */
export async function completeComposition(
  deps: PipelineDeps,
  data: ProjectJobData,
): Promise<boolean> {
  await mergeProjectMetadata(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    patch: { staleRenders: [] },
  });
  const moved = await transitionProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    from: ['RENDERING'],
    to: 'QUALITY_CHECKING',
  });
  if (!moved) return false;
  const job = projectJobOf(data);
  await deps.queue.add('run-quality-gate', job, { jobId: jobIds.runQualityGate(job) });
  // 15.A3 (Track A): generated thumbnail candidates (non-blocking, own job).
  await deps.queue.add('generate-thumbnail', job, { jobId: jobIds.generateThumbnail(job) });
  return true;
}

// ------------------------------------------------------------------ poll (poll-render)

type Check =
  | { kind: 'running' }
  | { kind: 'finished'; output: NonNullable<ProviderPollResult['output']> }
  | { kind: 'failed'; error: ProviderError };

function failure(providerId: string, errorClass: string, message: string, retryable = true) {
  return {
    kind: 'failed' as const,
    error: new ProviderError(providerId, errorClass, message, retryable),
  };
}

/** Where one pending render stands. Settles its provider job (cost, breaker) exactly once. */
async function checkRender(
  deps: PipelineDeps,
  data: ProjectJobData,
  entry: PendingRender,
): Promise<Check> {
  const adapter = await adapterFor(deps, data, entry.providerId);
  if (!adapter) return failure(entry.providerId, 'unknown', 'Composer is not configured');
  const row = await deps.tracking.repo.find(entry.providerJobRowId);
  if (!row) return failure(entry.providerId, 'unknown', 'Render job record is missing');
  const scope = { organisationId: data.organisationId };
  if (row.state === 'SUCCEEDED') {
    // Settled by an earlier poll that stopped before recording (crash, storage blip): fetch the
    // result again without tracking it a second time.
    const again = await adapter.poll(entry.providerJobId);
    return again.state === 'succeeded' && again.output?.url
      ? { kind: 'finished', output: again.output }
      : failure(entry.providerId, 'result_expired', 'Finished render is no longer available');
  }
  if (row.state !== 'RUNNING') {
    return failure(entry.providerId, 'unknown', `Render job is ${row.state.toLowerCase()}`);
  }
  if (deps.now() >= Date.parse(entry.giveUpAt)) {
    try {
      await cancelTracked(adapter, row.id, scope, deps.tracking);
    } catch (err) {
      // Providers without a cancel endpoint keep the reservation (they may still bill it).
      if (!(err instanceof NotImplementedError)) throw err;
    }
    await deps.breaker.recordFailure(adapter.providerId);
    const seconds = Math.round(deps.config.providerTimeoutMs / 1000);
    return failure(entry.providerId, 'timeout', `No result after ${seconds}s`);
  }
  const result = await pollTracked(adapter, row.id, scope, deps.tracking);
  if (result.state === 'running') return { kind: 'running' };
  await recordProviderSpend(deps, {
    organisationId: data.organisationId,
    projectId: data.projectId,
    planTier: data.planTier as PlanTier,
    providerId: adapter.providerId,
  });
  if (result.state === 'succeeded') {
    return result.output?.url
      ? { kind: 'finished', output: result.output }
      : failure(adapter.providerId, 'unknown', 'Composer returned no render URL');
  }
  const error = result.error ?? { class: 'unknown', message: 'Provider failed', retryable: true };
  return failure(adapter.providerId, error.class, error.message, error.retryable);
}

/** A failed variant: its slot and pending entry go; the caller re-submits or fails the run. */
async function dropPending(
  deps: PipelineDeps,
  data: ProjectJobData,
  scriptId: string,
  entry: PendingRender,
): Promise<void> {
  await releaseSubmissionSlot(deps, { ...entry, organisationId: data.organisationId });
  await deleteRunEntry(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    key: PENDING_RENDERS_KEY,
    entryKey: scriptId,
  });
}

export interface PollOutcome {
  recorded: number;
  running: number;
  failed: number;
  completed: boolean;
  retried: boolean;
}

/** The poll-render job. */
export async function pollRenders(
  data: PollRenderJobData,
  deps: PipelineDeps,
): Promise<PollOutcome | null> {
  const log = deps.logger.child({ projectId: data.projectId, runId: data.runId });
  const project = await deps.db.videoProject.findUnique({
    where: { id: data.projectId },
    select: {
      organisationId: true,
      state: true,
      metadata: true,
      scripts: { select: { id: true } },
    },
  });
  if (!project || project.organisationId !== data.organisationId) return null;
  if (currentRunId(project) !== data.runId || project.state !== 'RENDERING') {
    log.info({ state: project.state }, 'render poll for a run that moved on; ignored');
    return null;
  }
  const token = jobIds.pollRender(data, `${data.chain}-${data.poll}`);
  const run = { projectId: data.projectId, runId: data.runId };
  const claimed = await claimRenderPoll(deps.db, {
    ...run,
    token,
    now: deps.now(),
    leaseMs: POLL_CLAIM_MS,
  });
  if (claimed === null) {
    log.info('another render poll is working on this run');
    // A chain poll keeps the chain alive (the holder may be a callback's one-off poll, which never
    // schedules a successor); its next look finds nothing to do once the renders are recorded.
    if (!data.wake) {
      const waiting = Object.values(pendingRendersOf(project.metadata));
      const delay = await nextPollDelayMs(deps, data, waiting);
      await schedulePoll(deps, data, data.chain, data.poll + 1, delay);
    }
    return null;
  }
  try {
    return await pollClaimed(
      deps,
      data,
      claimed,
      project.scripts.map((s) => s.id),
    );
  } finally {
    await releaseRenderPoll(deps.db, { projectId: data.projectId, token });
  }
}

async function pollClaimed(
  deps: PipelineDeps,
  data: PollRenderJobData,
  metadata: Prisma.JsonValue,
  scriptIds: readonly string[],
): Promise<PollOutcome> {
  const log = deps.logger.child({ projectId: data.projectId, runId: data.runId });
  const pending = pendingRendersOf(metadata);
  const outcome: PollOutcome = {
    recorded: 0,
    running: 0,
    failed: 0,
    completed: false,
    retried: false,
  };
  const errors: ProviderError[] = [];
  const stillRunning: PendingRender[] = [];
  for (const [scriptId, entry] of Object.entries(pending)) {
    const check = await checkRender(deps, data, entry);
    if (check.kind === 'running') {
      outcome.running += 1;
      stillRunning.push(entry);
      continue;
    }
    if (check.kind === 'failed') {
      outcome.failed += 1;
      errors.push(check.error);
      await dropPending(deps, data, scriptId, entry);
      continue;
    }
    const metadataOut = (check.output.metadata ?? {}) as { renderId?: string };
    try {
      await finishRender(deps, data, {
        scriptId,
        targetPlatform: entry.targetPlatform,
        aspectRatio: entry.aspectRatio,
        composition: entry.composition,
        url: check.output.url!,
        providerId: entry.providerId,
        providerJobRowId: entry.providerJobRowId,
        composerJobId: metadataOut.renderId ?? null,
        fallback: entry.fallback ?? null,
      });
    } catch (err) {
      if (err instanceof StaleRunError) return { ...outcome, completed: false };
      throw err; // storage / DB blip: BullMQ retries this poll; the render is fetched again
    }
    await releaseSubmissionSlot(deps, { ...entry, organisationId: data.organisationId });
    outcome.recorded += 1;
  }

  if (errors.length > 0) {
    outcome.retried = await retryOrFail(deps, data, metadata, errors);
    if (!outcome.retried) return outcome; // the run failed; its other renders were cancelled
  }
  const rendered = renderPointersOf(
    (
      await deps.db.videoProject.findUnique({
        where: { id: data.projectId },
        select: { metadata: true },
      })
    )?.metadata ?? null,
  );
  if (stillRunning.length === 0 && errors.length === 0) {
    if (scriptIds.every((id) => rendered[id])) {
      outcome.completed = await completeComposition(deps, data);
      log.info({ renders: scriptIds.length }, 'renders complete; quality gate enqueued');
    }
    return outcome;
  }
  // Only the chain schedules the next poll (a callback's one-off poll never forks it).
  if (stillRunning.length > 0 && !data.wake) {
    const delay = await nextPollDelayMs(deps, data, stillRunning);
    await schedulePoll(deps, data, data.chain, data.poll + 1, delay);
  }
  return outcome;
}

/**
 * Failed variants are submitted again by compose-video (it skips recorded and still-pending ones)
 * after the 3.9 backoff, at most MAX_RETRIES times per run; a non-retryable failure, or one past
 * the limit, fails the project (composition_failed) as the synchronous compose did.
 */
async function retryOrFail(
  deps: PipelineDeps,
  data: PollRenderJobData,
  metadata: Prisma.JsonValue,
  errors: readonly ProviderError[],
): Promise<boolean> {
  const retries = composeRetriesOf(metadata);
  const first = errors[0]!;
  const job = projectJobOf(data);
  if (errors.every(isRetryable) && retries < MAX_RETRIES) {
    await mergeProjectMetadata(deps.db, {
      projectId: data.projectId,
      runId: data.runId,
      patch: { [COMPOSE_RETRIES_KEY]: retries + 1 },
    });
    await deps.queue.add('compose-video', job, {
      jobId: jobIds.composeRetry(job, retries + 1),
      delayMs: retryDelayMs(retries + 1),
    });
    deps.logger.warn(
      { projectId: data.projectId, failed: errors.length, retry: retries + 1, err: first },
      'renders failed; re-submitting them',
    );
    return true;
  }
  await cancelPendingRenders(deps, job);
  await failProject(deps.db, { ...job, reason: `composition_failed: ${describeError(first)}` });
  return false;
}

/** Cancel a run's renders still in flight (best effort) and drop them. */
export async function cancelPendingRenders(
  deps: PipelineDeps,
  data: ProjectJobData,
): Promise<void> {
  const project = await deps.db.videoProject.findUnique({
    where: { id: data.projectId },
    select: { metadata: true },
  });
  for (const [scriptId, entry] of Object.entries(pendingRendersOf(project?.metadata ?? null))) {
    try {
      const adapter = await adapterFor(deps, data, entry.providerId);
      if (adapter)
        await cancelTracked(adapter, entry.providerJobRowId, data, deps.tracking).catch(
          (err: unknown) => {
            if (!(err instanceof NotImplementedError)) throw err;
          },
        );
    } catch (err) {
      deps.logger.warn({ err, projectId: data.projectId, scriptId }, 'render cancel failed');
    }
    await dropPending(deps, data, scriptId, entry);
  }
}

// ------------------------------------------------------------------ callback wake (web)

/**
 * A render callback confirmed a render ended: run the run's next poll now. Promotes the delayed
 * chain poll when there is one; otherwise (the chain is mid-poll) adds a one-off poll whose job id
 * is per provider job, so a replayed callback adds nothing. Either way the poll claim makes the
 * render recorded once.
 */
export async function wakeRenderPoll(
  deps: Pick<PipelineDeps, 'db' | 'queue' | 'logger'>,
  input: { projectId: string; providerJobRowId: string },
): Promise<'promoted' | 'enqueued' | 'not_pending'> {
  const project = await deps.db.videoProject.findUnique({
    where: { id: input.projectId },
    select: { organisationId: true, metadata: true, state: true },
  });
  const runId = project ? currentRunId(project) : undefined;
  if (!project || !runId || project.state !== 'RENDERING') return 'not_pending';
  const entry = Object.values(pendingRendersOf(project.metadata)).find(
    (e) => e.providerJobRowId === input.providerJobRowId,
  );
  if (!entry) return 'not_pending';
  const next = (project.metadata as Record<string, unknown> | null)?.[RENDER_POLL_NEXT_KEY];
  if (typeof next === 'string' && (await deps.queue.promote?.('poll-render', next))) {
    return 'promoted';
  }
  const data: PollRenderJobData = {
    projectId: input.projectId,
    organisationId: project.organisationId,
    runId,
    planTier: entry.planTier as PlanTier,
    ...(entry.batch && { batch: true }),
    chain: `wake-${input.providerJobRowId}`,
    poll: 0,
    wake: true,
  };
  await deps.queue.add('poll-render', data, {
    jobId: jobIds.pollRender(data, `wake-${input.providerJobRowId}`),
  });
  return 'enqueued';
}
