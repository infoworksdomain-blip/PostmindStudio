import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { StudioError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { projectMetadata } from '../pipeline/project-state';
import type { AssetStorage } from '../storage';
import type { JobQueue } from '../queue/enqueue';
import { createPublication, createPublicationInput } from '../services/publications';
import { AUTO_PUBLISH_ACTOR, mergeMetadata } from './approval';
import { storedTargets, type AutoPublishTarget } from './targets';

// publishPolicy AUTO_ON_APPROVAL (spec 3 "auto-publish (on approval per template)"): when a
// project becomes APPROVED — by a person or automatically — each stored target becomes a
// publication through createPublication, the same service (validation, render quality, platform
// format rules, credential checks, duplicate guard) that POST /publications uses. Targets are
// independent: one that fails is recorded on the project and the others still go out.

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

async function publishTarget(
  deps: AutoPublishDeps,
  tenant: TenantContext,
  target: AutoPublishTarget,
  index: number,
  renderId: string | undefined,
): Promise<AutoPublishTargetResult> {
  const base = {
    index,
    platform: target.platform,
    account: target.connectionId ?? target.platformAccountId ?? null,
  };
  if (!renderId)
    return { ...base, status: 'failed', error: `No ${target.platform} render in this version` };
  const scheduledFor = target.scheduleOffsetMinutes
    ? new Date(deps.now() + target.scheduleOffsetMinutes * 60_000).toISOString()
    : undefined;
  const input = createPublicationInput.safeParse({
    renderId,
    platform: target.platform,
    connectionId: target.connectionId,
    platformAccountId: target.platformAccountId,
    caption: target.caption ?? '',
    hashtags: target.hashtags ?? [],
    scheduledFor,
  });
  if (!input.success)
    return { ...base, status: 'failed', error: 'Target does not form a valid publication' };
  try {
    const publication = await createPublication(deps, tenant, input.data);
    deps.audit({
      actorUserId: AUTO_PUBLISH_ACTOR,
      organisationId: tenant.organisationId,
      action: scheduledFor ? 'studio.publication.schedule' : 'studio.publication.publish',
      resource: { type: 'video_publication', id: publication.id },
      metadata: { platform: target.platform, renderId, scheduledFor: scheduledFor ?? null },
    });
    return {
      ...base,
      status: 'created',
      publicationId: publication.id,
      scheduledFor: scheduledFor ?? null,
    };
  } catch (err) {
    if (!(err instanceof StudioError))
      deps.logger.error({ err, target: index }, 'auto-publish target failed unexpectedly');
    return { ...base, status: 'failed', error: errorText(err) };
  }
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
  if (project.publishPolicy !== 'AUTO_ON_APPROVAL')
    return { status: 'skipped', reason: `publish policy is ${project.publishPolicy}` };

  const targets = storedTargets(project.metadata);
  const record = async (
    status: AutoPublishResult['status'],
    results: AutoPublishTargetResult[],
  ) => {
    const result: AutoPublishResult = {
      at: new Date(deps.now()).toISOString(),
      trigger: input.trigger,
      status,
      results,
    };
    await mergeMetadata(deps.db, project.id, { autoPublishResult: result });
    return { status, results };
  };
  if (targets.length === 0) {
    log.info('AUTO_ON_APPROVAL project has no auto-publish targets; nothing published');
    return record('no_targets', []);
  }

  const renderIds = Object.values(
    (projectMetadata(project.metadata).renders as Record<string, string> | undefined) ?? {},
  );
  const renders = await deps.db.videoRender.findMany({
    where: { id: { in: renderIds }, projectId: project.id },
    select: { id: true, targetPlatform: true },
  });
  const tenant = systemTenant(input.organisationId, input.planTier);
  const results: AutoPublishTargetResult[] = [];
  // Sequential: createPublication serialises per (render, platform, account) anyway, and the
  // order of results should match the order of targets.
  for (const [index, target] of targets.entries()) {
    const renderId = renders.find((r) => r.targetPlatform === target.platform)?.id;
    results.push(await publishTarget(deps, tenant, target, index, renderId));
  }
  const created = results.filter((r) => r.status === 'created').length;
  const status = created === results.length ? 'created' : created > 0 ? 'partial' : 'failed';
  log.info({ created, failed: results.length - created }, 'auto-publish on approval complete');
  return record(status, results);
}

/**
 * Called after every approval (route and auto-approve). Never throws: the approval has already
 * committed, so an unexpected failure is logged and recorded on the project for the UI.
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
      error: 'Auto-publish could not run; publish from the Publish tab',
    };
    await mergeMetadata(deps.db, input.projectId, { autoPublishResult: result }).catch(
      (recordErr: unknown) =>
        deps.logger.error({ err: recordErr }, 'could not record the auto-publish failure'),
    );
    return { status: 'failed', results: [] };
  }
}
