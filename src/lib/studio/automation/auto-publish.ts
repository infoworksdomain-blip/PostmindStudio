import type { AutoPublishOutbox, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { StudioError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { fitCaption } from '../platforms/captions';
import type { AssetStorage } from '../storage';
import type { JobQueue } from '../queue/enqueue';
import { createPublication, createPublicationInput } from '../services/publications';
import { AUTO_PUBLISH_ACTOR, mergeMetadata } from './approval';
import {
  coveringPublicationId,
  dispatchOutbox,
  isRetryableSendError,
  latestOutbox,
  MAX_OUTBOX_ATTEMPTS,
  renderIdFor,
  type SendOutcome,
  type TargetSender,
} from './outbox';
import { storedTargets, type AutoPublishTarget } from './targets';

// publishPolicy AUTO_ON_APPROVAL (spec 3 "auto-publish (on approval per template)"): when a
// project becomes APPROVED — by a person or automatically — each stored target becomes a
// publication through createPublication, the same service (validation, render quality, platform
// format rules, credential checks, duplicate guard) that POST /publications uses. Targets are
// independent: one that fails is recorded on the project and the others still go out.
// BACKLOG 13.21: targets travel through the auto-publish outbox (automation/outbox.ts), written in
// the approval transaction and retried by the dispatcher job, so a crash between approval and
// publishing can no longer lose them. metadata.autoPublishResult mirrors the outbox for the UI.
// 15.A5: publishPolicy SCHEDULED travels the same way (rows carry an absolute scheduledFor).
// 15.A9: captions Studio sends on its own are fitted to the platform limit (fitCaption) instead
// of failing on a 400; the publication records metadata.captionTruncated.

export interface AutoPublishDeps {
  db: PrismaClient;
  queue: JobQueue;
  storage: AssetStorage;
  now: () => number;
  audit: (entry: AuditEntry) => void;
  logger: Logger;
}

export interface AutoPublishTargetResult {
  index: number;
  platform: string;
  account: string | null;
  status: 'created' | 'failed';
  publicationId?: string;
  scheduledFor?: string | null;
  error?: string;
  /** 13.21: the outbox will try again at this time (status failed, not given up yet). */
  retryAt?: string;
}

/** metadata.autoPublishResult — what the Review screen shows. */
export interface AutoPublishResult {
  at: string;
  trigger: 'human' | 'auto';
  status: 'created' | 'partial' | 'failed' | 'no_targets';
  results: AutoPublishTargetResult[];
  /** Set when auto-publish could not run at all (no per-target results). */
  error?: string;
}

export type AutoPublishOutcome =
  | { status: 'skipped'; reason: string }
  | ({ status: AutoPublishResult['status'] } & Pick<AutoPublishResult, 'results'>);

function errorText(err: unknown): string {
  if (!(err instanceof StudioError)) return 'Unexpected error while creating the publication';
  const problems = (err.details as { problems?: unknown; issues?: unknown } | undefined)?.problems;
  return Array.isArray(problems) && problems.length
    ? `${err.message}: ${problems.map(String).join('; ')}`.slice(0, 500)
    : err.message.slice(0, 500);
}

/** The system actor that owns auto-created publications; capabilities are not consulted. */
function systemTenant(organisationId: string, planTier: string): TenantContext {
  return {
    userId: AUTO_PUBLISH_ACTOR,
    organisationId,
    organisation: { id: organisationId, planTier },
    memberships: [],
    capabilities: [],
  };
}

/** Sends one outbox row through createPublication (the POST /publications service). */
export function createTargetSender(deps: AutoPublishDeps): TargetSender {
  return async (row: AutoPublishOutbox, target: AutoPublishTarget): Promise<SendOutcome> => {
    const project = await deps.db.videoProject.findFirst({
      where: { id: row.projectId, organisationId: row.organisationId, deletedAt: null },
      select: { metadata: true, renders: { select: { id: true, targetPlatform: true } } },
    });
    if (!project) return { status: 'failed', error: 'Project not found', retryable: false };
    const renderId = renderIdFor(project.metadata, project.renders, target.platform);
    if (!renderId)
      return {
        status: 'failed',
        error: `No ${target.platform} render in this version`,
        retryable: false,
      };
    const scheduledFor = row.scheduledFor
      ? row.scheduledFor.toISOString()
      : target.scheduleOffsetMinutes
        ? new Date(row.createdAt.getTime() + target.scheduleOffsetMinutes * 60_000).toISOString()
        : undefined;
    let fitted: { caption: string; truncated: boolean };
    try {
      fitted = fitCaption(target.platform, {
        caption: target.caption ?? '',
        hashtags: target.hashtags ?? [],
      });
    } catch (err) {
      return { status: 'failed', error: errorText(err), retryable: false };
    }
    const input = createPublicationInput.safeParse({
      renderId,
      platform: target.platform,
      connectionId: target.connectionId,
      platformAccountId: target.platformAccountId,
      caption: fitted.caption,
      hashtags: target.hashtags ?? [],
      // A retry after the scheduled time publishes now rather than failing on a past schedule.
      scheduledFor:
        scheduledFor && Date.parse(scheduledFor) > deps.now() + 60_000 ? scheduledFor : undefined,
    });
    if (!input.success)
      return {
        status: 'failed',
        error: 'Target does not form a valid publication',
        retryable: false,
      };
    try {
      const tenant = systemTenant(row.organisationId, row.planTier);
      const publication = await createPublication(deps, tenant, input.data, {
        captionTruncated: fitted.truncated,
      });
      deps.audit({
        actorUserId: AUTO_PUBLISH_ACTOR,
        organisationId: row.organisationId,
        action: input.data.scheduledFor
          ? 'studio.publication.schedule'
          : 'studio.publication.publish',
        resource: { type: 'video_publication', id: publication.id },
        metadata: {
          platform: target.platform,
          renderId,
          scheduledFor: input.data.scheduledFor ?? null,
          captionTruncated: fitted.truncated,
          outboxId: row.id,
          attempt: row.attempts + 1,
        },
      });
      return {
        status: 'sent',
        publicationId: publication.id,
        scheduledFor: input.data.scheduledFor ?? null,
      };
    } catch (err) {
      // Already scheduled or published to that account (e.g. a sender died after creating it).
      const covering = coveringPublicationId(err);
      if (covering) return { status: 'sent', publicationId: covering };
      if (!(err instanceof StudioError))
        deps.logger.error({ err, outboxId: row.id }, 'auto-publish target failed unexpectedly');
      return { status: 'failed', error: errorText(err), retryable: isRetryableSendError(err) };
    }
  };
}

function toResult(row: AutoPublishOutbox): AutoPublishTargetResult {
  const target = row.target as unknown as AutoPublishTarget;
  const base = {
    index: row.targetIndex,
    platform: target.platform,
    account: target.connectionId ?? target.platformAccountId ?? null,
    ...(row.scheduledFor && { scheduledFor: row.scheduledFor.toISOString() }),
  };
  if (row.state === 'SENT')
    return {
      ...base,
      status: 'created',
      ...(row.publicationId && { publicationId: row.publicationId }),
    };
  const retrying = row.state === 'PENDING' || row.state === 'SENDING';
  return {
    ...base,
    status: 'failed',
    error:
      row.lastError ??
      (retrying ? 'Waiting to be sent' : `Gave up after ${MAX_OUTBOX_ATTEMPTS} attempts`),
    ...(retrying && { retryAt: row.nextAttemptAt.toISOString() }),
  };
}

/** Mirror the latest approval's outbox rows into metadata.autoPublishResult. */
export async function recordOutboxResult(
  deps: Pick<AutoPublishDeps, 'db' | 'now'>,
  projectId: string,
  trigger: 'human' | 'auto',
): Promise<Extract<AutoPublishOutcome, { results: unknown }>> {
  const rows = await latestOutbox(deps.db, projectId);
  const results = rows.map(toResult);
  const created = results.filter((r) => r.status === 'created').length;
  const status: AutoPublishResult['status'] =
    results.length === 0
      ? 'no_targets'
      : created === results.length
        ? 'created'
        : created > 0
          ? 'partial'
          : 'failed';
  const result: AutoPublishResult = {
    at: new Date(deps.now()).toISOString(),
    trigger: (rows[0]?.trigger as 'human' | 'auto' | undefined) ?? trigger,
    status,
    results,
  };
  await mergeMetadata(deps.db, projectId, { autoPublishResult: result });
  return { status, results };
}

export async function runAutoPublish(
  deps: AutoPublishDeps,
  input: {
    projectId: string;
    organisationId: string;
    planTier: string;
    trigger: 'human' | 'auto';
  },
): Promise<AutoPublishOutcome> {
  const log = deps.logger.child({
    projectId: input.projectId,
    organisationId: input.organisationId,
  });
  const project = await deps.db.videoProject.findFirst({
    where: { id: input.projectId, organisationId: input.organisationId, deletedAt: null },
  });
  if (!project) return { status: 'skipped', reason: 'project not found' };
  if (project.publishPolicy !== 'AUTO_ON_APPROVAL' && project.publishPolicy !== 'SCHEDULED')
    return { status: 'skipped', reason: `publish policy is ${project.publishPolicy}` };
  if (storedTargets(project.metadata).length === 0)
    log.info(`${project.publishPolicy} project has no publish targets; nothing published`);

  // The rows were written with the approval; send the due ones now (the dispatcher job covers
  // anything this request does not get to).
  await dispatchOutbox(deps, createTargetSender(deps), { projectId: project.id });
  const outcome = await recordOutboxResult(deps, project.id, input.trigger);
  log.info(
    { status: outcome.status, targets: outcome.results.length },
    'auto-publish on approval dispatched',
  );
  return outcome;
}

/**
 * Called after every approval (route and auto-approve). Never throws: the approval has already
 * committed (with its outbox rows), so an unexpected failure is logged and recorded for the UI;
 * the dispatcher job still sends the rows.
 */
export async function publishOnApproval(
  deps: AutoPublishDeps,
  input: Parameters<typeof runAutoPublish>[1],
): Promise<AutoPublishOutcome> {
  try {
    return await runAutoPublish(deps, input);
  } catch (err) {
    deps.logger.error({ err, projectId: input.projectId }, 'auto-publish on approval failed');
    const result: AutoPublishResult = {
      at: new Date(deps.now()).toISOString(),
      trigger: input.trigger,
      status: 'failed',
      results: [],
      error:
        'Auto-publish is retrying in the background; you can also publish from the Publish tab',
    };
    await mergeMetadata(deps.db, input.projectId, { autoPublishResult: result }).catch(
      (recordErr: unknown) =>
        deps.logger.error({ err: recordErr }, 'could not record the auto-publish failure'),
    );
    return { status: 'failed', results: [] };
  }
}

/** Dispatcher job body: send every due row, then refresh each touched project's result. */
export async function dispatchAutoPublishOutbox(
  deps: AutoPublishDeps,
): Promise<{ sent: number; failed: number; retrying: number }> {
  const settled = await dispatchOutbox(deps, createTargetSender(deps));
  for (const projectId of new Set(settled.map((r) => r.projectId))) {
    const trigger = (settled.find((r) => r.projectId === projectId)?.trigger ?? 'auto') as
      'human' | 'auto';
    await recordOutboxResult(deps, projectId, trigger).catch((err: unknown) =>
      deps.logger.error({ err, projectId }, 'could not refresh the auto-publish result'),
    );
  }
  return {
    sent: settled.filter((r) => r.state === 'SENT').length,
    failed: settled.filter((r) => r.state === 'FAILED').length,
    retrying: settled.filter((r) => r.state === 'PENDING').length,
  };
}

/** 15.A5 — the approve response's `scheduled` list: when each target is due to go live. */
export function scheduledSummary(
  outcome: AutoPublishOutcome,
): Array<{ platform: string; scheduledFor: string; publicationId: string | null }> {
  if (!('results' in outcome)) return [];
  return outcome.results.flatMap((r) =>
    r.scheduledFor
      ? [
          {
            platform: r.platform,
            scheduledFor: r.scheduledFor,
            publicationId: r.publicationId ?? null,
          },
        ]
      : [],
  );
}
