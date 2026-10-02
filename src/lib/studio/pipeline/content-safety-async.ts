import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type VideoRender } from '@prisma/client';
import { z } from 'zod';
import {
  ConfigurationError,
  NoProviderAvailableError,
  NotFoundError,
  ProviderError,
  ValidationError,
} from '../../errors';
import { summariseHiveOutput, type ContentSafetyScan } from '../providers/hive';
import type { PlanTier } from '../providers/router';
import { routeProvider } from '../providers/router';
import { cancelTracked, pollTracked, submitTracked } from '../providers/tracked';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import type { PipelineDeps } from './deps';

// BACKLOG 13.25 — asynchronous content-safety scans for renders longer than Hive's 90 s sync
// limit, so long-form (YouTube 4–8 min) can reach review.
//
// Flow: the quality gate submits the render to Hive's async API with a per-task callback URL
// and records a content_safety_tasks row, then leaves the project in QUALITY_CHECKING. Hive
// POSTs the finished task to POST /api/studio/webhooks/hive?token=…; the webhook stores the
// body and re-enqueues run-quality-gate, which settles the tracked provider job (cost, breaker)
// through the adapter's poll() and evaluates the scan like a sync one.
//
// AUTHENTICATION: Hive documents no signature or shared secret on callbacks (docs.thehive.ai
// reference "Submit a Task Asynchronously" / "Async Task Request", read 2026-09-27), so each task
// gets an unguessable 256-bit token in its callback URL. Only its SHA-256 is stored; a token is
// single-use (the row leaves SUBMITTED on the first callback) and the body's task id must match
// the id Hive acknowledged. Fail closed: no callback base URL, a failed task, or no callback
// within the timeout (a delayed gate job checks) all fail the content-safety check.

export const DEFAULT_HIVE_ASYNC_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TIMEOUT_GRACE_MS = 60_000;
export const HIVE_WEBHOOK_PATH = '/api/studio/webhooks/hive';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REASON_MAX = 500;

export type AsyncScanOutcome =
  { pending: true } | { scan: ContentSafetyScan } | { unavailable: string; humanReview?: boolean };

/** STUDIO_PUBLIC_CALLBACK_BASE_URL: an https origin (http only for localhost development). */
export function parseCallbackBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('STUDIO_PUBLIC_CALLBACK_BASE_URL must be an absolute URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new ConfigurationError('STUDIO_PUBLIC_CALLBACK_BASE_URL must use https');
  }
  return url.origin;
}

/** HIVE_ASYNC_TIMEOUT_MIN: minutes to wait for a callback (1–1440, default 120). */
export function parseHiveTimeoutMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_HIVE_ASYNC_TIMEOUT_MS;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new ConfigurationError('HIVE_ASYNC_TIMEOUT_MIN must be a whole number from 1 to 1440');
  }
  return minutes * 60_000;
}

export function newCallbackToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashCallbackToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hiveCallbackUrl(baseUrl: string, token: string): string {
  const url = new URL(HIVE_WEBHOOK_PATH, baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
}

type Db = PrismaClient;

async function submitTask(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  mediaUrl: string,
  baseUrl: string,
): Promise<AsyncScanOutcome> {
  const timeoutMs = deps.config.hiveAsyncTimeoutMs ?? DEFAULT_HIVE_ASYNC_TIMEOUT_MS;
  const token = newCallbackToken();
  const request = {
    capability: 'content_safety' as const,
    organisationId: data.organisationId,
    projectId: data.projectId,
    mediaUrl,
    durationSec: render.durationSec,
    callbackUrl: hiveCallbackUrl(baseUrl, token),
  };
  let decision;
  try {
    decision = await routeProvider(
      {
        need: { kind: 'capability', capability: 'content_safety' },
        planTier: data.planTier,
        organisationId: data.organisationId,
        projectId: data.projectId,
        request,
      },
      deps,
    );
  } catch (err) {
    // 20.19: same as the sync scan — no provider means a person reviews the render.
    if (err instanceof NoProviderAvailableError)
      return { unavailable: 'no content-safety provider available', humanReview: true };
    throw err;
  }
  let row;
  try {
    row = await deps.db.contentSafetyTask.create({
      data: {
        organisationId: data.organisationId,
        projectId: data.projectId,
        runId: data.runId,
        renderId: render.id,
        planTier: data.planTier,
        providerId: decision.providerId,
        callbackTokenHash: hashCallbackToken(token),
        expiresAt: new Date(deps.now() + timeoutMs),
      },
    });
  } catch (err) {
    // A concurrent gate run already submitted this render for this run.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      return { pending: true };
    throw err;
  }
  let submitted;
  try {
    submitted = await submitTracked(decision.adapter, request, deps.tracking);
  } catch (err) {
    if (err instanceof ProviderError && err.retryable) {
      // Nothing is pending at Hive: drop the row so the job retry submits afresh.
      await deps.db.contentSafetyTask.delete({ where: { id: row.id } });
      throw err;
    }
    await deps.db.contentSafetyTask.update({
      where: { id: row.id },
      data: { state: 'FAILED', errorReason: reasonOf(err) },
    });
    if (err instanceof ProviderError) return { unavailable: err.message };
    throw err;
  }
  await deps.db.contentSafetyTask.update({
    where: { id: row.id },
    data: { providerJobRowId: submitted.jobId, providerTaskId: submitted.providerJobId },
  });
  // Fail-closed backstop: re-run the gate after the timeout in case Hive never calls back.
  await deps.queue.add('run-quality-gate', data, {
    jobId: `${jobIds.runQualityGate(data)}__hive_timeout_${row.id}`,
    delayMs: timeoutMs + TIMEOUT_GRACE_MS,
  });
  deps.logger.info(
    { projectId: data.projectId, renderId: render.id, hiveTaskId: submitted.providerJobId },
    'render submitted to async content-safety scan',
  );
  return { pending: true };
}

async function settleTask(
  deps: PipelineDeps,
  data: ProjectJobData,
  task: { id: string; providerId: string; providerJobRowId: string | null },
): Promise<AsyncScanOutcome> {
  const adapter = deps.registry.findAdapter(task.providerId);
  if (!adapter || !task.providerJobRowId) {
    await deps.db.contentSafetyTask.update({
      where: { id: task.id },
      data: { state: 'FAILED', errorReason: `${task.providerId} is not configured` },
    });
    return { unavailable: `${task.providerId} is not configured` };
  }
  const result = await pollTracked(
    adapter,
    task.providerJobRowId,
    { organisationId: data.organisationId },
    deps.tracking,
  );
  if (result.state === 'running') return { pending: true };
  if (result.state === 'failed') {
    const reason = result.error?.message ?? 'content-safety task failed';
    await deps.db.contentSafetyTask.update({
      where: { id: task.id },
      data: { state: 'FAILED', errorReason: reason.slice(0, REASON_MAX) },
    });
    return { unavailable: reason };
  }
  await deps.db.contentSafetyTask.update({ where: { id: task.id }, data: { state: 'SETTLED' } });
  return { scan: result.output?.metadata as ContentSafetyScan };
}

async function expireTask(
  deps: PipelineDeps,
  data: ProjectJobData,
  task: { id: string; providerId: string; providerJobRowId: string | null },
): Promise<AsyncScanOutcome> {
  const adapter = deps.registry.findAdapter(task.providerId);
  if (adapter && task.providerJobRowId) {
    await cancelTracked(
      adapter,
      task.providerJobRowId,
      { organisationId: data.organisationId },
      deps.tracking,
    );
  }
  const minutes = Math.round(
    (deps.config.hiveAsyncTimeoutMs ?? DEFAULT_HIVE_ASYNC_TIMEOUT_MS) / 60_000,
  );
  const reason = `no moderation callback within ${minutes} min`;
  await deps.db.contentSafetyTask.update({
    where: { id: task.id },
    data: { state: 'EXPIRED', errorReason: reason },
  });
  return { unavailable: reason };
}

/**
 * The async content-safety outcome for one render of this run: submits on first sight, then
 * reports pending until Hive's callback has been stored, then settles it into a scan.
 */
export async function asyncContentSafety(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  mediaUrl: string,
): Promise<AsyncScanOutcome> {
  const baseUrl = deps.config.hiveCallbackBaseUrl;
  if (!baseUrl) {
    return {
      unavailable: `video is ${Math.round(render.durationSec)}s; scans over 90s need STUDIO_PUBLIC_CALLBACK_BASE_URL for async moderation`,
    };
  }
  const task = await deps.db.contentSafetyTask.findUnique({
    where: { renderId_runId: { renderId: render.id, runId: data.runId } },
  });
  if (!task) return submitTask(deps, data, render, mediaUrl, baseUrl);
  switch (task.state) {
    case 'SUBMITTED':
      return deps.now() >= task.expiresAt.getTime()
        ? expireTask(deps, data, task)
        : { pending: true };
    case 'CALLBACK_RECEIVED':
      return settleTask(deps, data, task);
    case 'SETTLED':
      return {
        scan: summariseHiveOutput((task.result ?? {}) as Parameters<typeof summariseHiveOutput>[0]),
      };
    case 'FAILED':
    case 'EXPIRED':
      return { unavailable: task.errorReason ?? `content-safety task ${task.state.toLowerCase()}` };
  }
}

// ---------------------------------------------------------------- webhook side

/** The parts of Hive's task object the webhook checks; everything else is stored as sent. */
const callbackBody = z
  .object({
    id: z.string().min(1).max(200).optional(),
    status: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface HiveCallbackResult {
  received: true;
  duplicate: boolean;
  taskId: string;
  organisationId: string;
  projectId: string;
}

/**
 * Store a Hive callback and resume the quality gate. Unknown or malformed tokens are a 404
 * (nothing reveals which tokens exist); a repeated callback for a settled task is acknowledged
 * without effect (Hive can re-send a task: `resent_on`).
 */
export async function recordHiveCallback(
  deps: { db: Db; queue: JobQueue; now: () => number },
  input: { token: string | null; body: unknown },
): Promise<HiveCallbackResult> {
  if (!input.token || !TOKEN_PATTERN.test(input.token)) throw new NotFoundError('Not found');
  const task = await deps.db.contentSafetyTask.findUnique({
    where: { callbackTokenHash: hashCallbackToken(input.token) },
  });
  if (!task) throw new NotFoundError('Not found');
  const parsed = callbackBody.safeParse(input.body);
  if (!parsed.success) throw new ValidationError('Callback body is not a Hive task object');
  if (parsed.data.id && task.providerTaskId && parsed.data.id !== task.providerTaskId) {
    throw new ValidationError('Callback task id does not match the submitted task');
  }
  const base = {
    received: true as const,
    taskId: task.id,
    organisationId: task.organisationId,
    projectId: task.projectId,
  };
  const moved = await deps.db.contentSafetyTask.updateMany({
    where: { id: task.id, state: 'SUBMITTED' },
    data: {
      state: 'CALLBACK_RECEIVED',
      result: parsed.data as Prisma.InputJsonValue,
      callbackAt: new Date(deps.now()),
      ...(!task.providerTaskId && parsed.data.id && { providerTaskId: parsed.data.id }),
    },
  });
  if (moved.count === 0) return { ...base, duplicate: true };
  const data: ProjectJobData = {
    projectId: task.projectId,
    organisationId: task.organisationId,
    runId: task.runId,
    planTier: task.planTier as PlanTier,
  };
  await deps.queue.add('run-quality-gate', data, {
    jobId: `${jobIds.runQualityGate(data)}__hive_${task.id}`,
  });
  return { ...base, duplicate: false };
}
