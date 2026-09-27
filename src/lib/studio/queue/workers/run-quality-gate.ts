import type { Prisma, VideoRender } from '@prisma/client';
import { NoProviderAvailableError, NotFoundError, ProviderError } from '../../../errors';
import { MAX_SYNC_DURATION_SEC, type ContentSafetyScan } from '../../providers/hive';
import type { AspectRatio } from '../../providers/interface';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  currentRunId,
  failProject,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { runProvider } from '../../pipeline/provider-run';
import {
  BLACK_FRAME_MAX_SEC,
  evaluateQuality,
  hasContentSafetyBlock,
  qualityPassed,
  type QualityCheck,
  type QualityInputs,
} from '../../pipeline/quality-checks';
import type { ProjectJobData } from '../queues';

// BACKLOG 3.7 — Layer 8 (spec 5.9 / 13.1). Every render of the run is measured with ffprobe /
// ffmpeg, scanned for content safety, and evaluated fail-closed. All pass → READY_FOR_REVIEW;
// otherwise QUALITY_FAILED with the reasons (force-approve for non-block failures is a Phase 4
// API with the studio:render:force-approve capability).

async function scanContentSafety(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  url: string,
): Promise<QualityInputs['contentSafety']> {
  if (render.durationSec > MAX_SYNC_DURATION_SEC) {
    return {
      unavailable: `video is ${Math.round(render.durationSec)}s; only ≤${MAX_SYNC_DURATION_SEC}s can be scanned until async moderation is built`,
    };
  }
  try {
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'content_safety' },
        planTier: data.planTier,
        request: {
          capability: 'content_safety',
          organisationId: data.organisationId,
          projectId: data.projectId,
          mediaUrl: url,
          durationSec: render.durationSec,
        },
      },
      deps,
    );
    return { scan: run.output.metadata as ContentSafetyScan };
  } catch (err) {
    // Transient provider trouble → retry the job. Anything else → fail closed, not "passed".
    if (err instanceof ProviderError && err.retryable) throw err;
    if (err instanceof NoProviderAvailableError)
      return { unavailable: 'no content-safety provider available' };
    if (err instanceof ProviderError) return { unavailable: err.message };
    throw err;
  }
}

async function checkRender(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  targetDurationSec: number,
) {
  const url = await deps.storage.signedUrl(render.s3Bucket, render.s3Key);
  const [probe, blackIntervals, loudnessLufs, contentSafety] = await Promise.all([
    deps.media.probe(url),
    deps.media.blackIntervals(url, BLACK_FRAME_MAX_SEC),
    deps.media.integratedLoudness(url),
    scanContentSafety(deps, data, render, url),
  ]);
  return evaluateQuality({
    target: { durationSec: targetDurationSec, aspectRatio: render.aspectRatio as AspectRatio },
    probe,
    blackIntervals,
    loudnessLufs,
    contentSafety,
  });
}

function summarise(results: Array<{ platform: string; checks: QualityCheck[] }>): string {
  return results
    .flatMap(({ platform, checks }) =>
      checks
        .filter((c) => c.status === 'failed')
        .map(
          (c) => `${platform}/${c.code}${c.severity === 'block' ? ' [BLOCK]' : ''}: ${c.detail}`,
        ),
    )
    .join('; ');
}

export async function runQualityGate(data: ProjectJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  const project = await deps.db.videoProject.findUnique({ where: { id: data.projectId } });
  if (!project || project.organisationId !== data.organisationId)
    throw new NotFoundError('Project not found');
  if (currentRunId(project) !== data.runId) return log.info('stale quality-gate job ignored');
  if (project.state !== 'QUALITY_CHECKING')
    return log.info({ state: project.state }, 'not awaiting quality checks; skipped');

  const renderIds = Object.values(
    (projectMetadata(project.metadata).renders as Record<string, string>) ?? {},
  );
  const renders = await deps.db.videoRender.findMany({
    where: { id: { in: renderIds }, projectId: project.id },
  });
  if (renders.length === 0) throw new NotFoundError('No renders recorded for this run');
  const scripts = new Map(
    (await deps.db.videoScript.findMany({ where: { projectId: project.id } })).map((s) => [
      s.id,
      s,
    ]),
  );

  const results = await Promise.all(
    renders.map(async (render) => {
      const target = scripts.get(render.scriptId)?.targetDurationSec ?? render.durationSec;
      const checks = await checkRender(deps, data, render, target);
      await deps.db.videoRender.update({
        where: { id: render.id },
        data: {
          qualityCheckState: qualityPassed(checks) ? 'PASSED' : 'FAILED',
          qualityIssues: checks as unknown as Prisma.InputJsonValue,
        },
      });
      return { platform: render.targetPlatform, checks };
    }),
  );

  const allPassed = results.every((r) => qualityPassed(r.checks));
  const blocked = results.some((r) => hasContentSafetyBlock(r.checks));
  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['QUALITY_CHECKING'],
    to: allPassed ? 'READY_FOR_REVIEW' : 'QUALITY_FAILED',
    data: allPassed
      ? { completedAt: new Date(deps.now()), errorReason: null }
      : {
          errorReason:
            `${blocked ? 'content_safety_block' : 'quality_failed'}: ${summarise(results)}`.slice(
              0,
              2_000,
            ),
        },
  });
  log.info({ allPassed, blocked }, 'quality gate complete');
}

export async function onRunQualityGateFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await failProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    reason: `quality_gate_error: ${reason}`,
  });
}
