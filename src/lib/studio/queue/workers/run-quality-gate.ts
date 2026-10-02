import type { Prisma, VideoRender } from '@prisma/client';
import { NoProviderAvailableError, NotFoundError, ProviderError } from '../../../errors';
import { usesAsyncHiveScan, type ContentSafetyScan } from '../../providers/hive';
import type { AspectRatio } from '../../providers/interface';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  currentRunId,
  failProject,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { runProvider } from '../../pipeline/provider-run';
import { asyncContentSafety } from '../../pipeline/content-safety-async';
import {
  BLACK_FRAME_MAX_SEC,
  contentSafetyReviewCheck,
  evaluateQuality,
  hasContentSafetyBlock,
  qualityPassed,
  type QualityCheck,
  type QualityInputs,
} from '../../pipeline/quality-checks';
import type { ProjectJobData } from '../queues';
import { autoApproveIfTrusted } from '../../automation/auto-approve';
import { notifyGenerationComplete } from '../../notifications/events';
import { openSafetyReview, pendingSafetyReview } from '../../pipeline/safety-review';
import { recordQualityGateOutcome } from '../../observability/slo';
import { renderSyncChecks } from '../../pipeline/quality-brand-gate';

// BACKLOG 3.7 — Layer 8 (spec 5.9 / 13.1). Every render of the run is measured with ffprobe /
// ffmpeg, scanned for content safety, and evaluated fail-closed. All pass → READY_FOR_REVIEW;
// otherwise QUALITY_FAILED with the reasons (force-approve for non-block failures is a Phase 4
// API with the studio:render:force-approve capability).

async function scanContentSafety(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  url: string,
  asyncOutcome?: QualityInputs['contentSafety'],
): Promise<QualityInputs['contentSafety']> {
  // 13.25: renders over Hive's sync limit were scanned asynchronously before the media checks
  // (V2 only; 20.6 V3 scans every render synchronously, sampling frames past 60 s).
  if (usesAsyncHiveScan(render.durationSec, deps.config.hiveApiVersion)) {
    return asyncOutcome ?? { unavailable: 'async content-safety scan has no result' };
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
    // 20.6: a Hive rate limit (V3 self-serve keys: ~100 requests/day) is retryable too; the run
    // stays QUALITY_CHECKING until the retry passes, and fails closed when retries run out.
    if (err instanceof ProviderError && err.errorClass === 'rate_limited') {
      deps.logger.warn(
        { projectId: data.projectId, renderId: render.id, providerId: err.providerId },
        `content-safety scan rate limited: ${err.message}`,
      );
    }
    if (err instanceof ProviderError && err.retryable) throw err;
    // 20.19: no provider at all (none configured, or every one held for an account problem such
    // as a rejected key — the operator was alerted once by runProvider) → a person reviews the
    // render instead of the video failing with a block nobody can lift.
    if (err instanceof NoProviderAvailableError)
      return { unavailable: 'no content-safety provider available', humanReview: true };
    if (err instanceof ProviderError) return { unavailable: err.message };
    throw err;
  }
}

async function checkRender(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  targetDurationSec: number,
  project: { organisationId: string; businessId: string; brandKitId: string | null },
  asyncOutcome?: QualityInputs['contentSafety'],
) {
  const url = await deps.storage.signedUrl(render.s3Bucket, render.s3Key);
  const [probe, blackIntervals, loudnessLufs, contentSafety] = await Promise.all([
    deps.media.probe(url),
    deps.media.blackIntervals(url, BLACK_FRAME_MAX_SEC),
    deps.media.integratedLoudness(url),
    scanContentSafety(deps, data, render, url, asyncOutcome),
  ]);
  // 15.B2: audio/caption sync, watermark and brand-kit checks from the rendered timeline.
  const sync = await renderSyncChecks(deps, {
    render,
    renderUrl: url,
    renderWidth: probe.width,
    project,
  });
  // Brand intro/outro (and platform) cards lengthen the video beyond the script's target.
  const cardsSec = sync.summary ? sync.summary.introSec + sync.summary.outroSec : 0;
  return evaluateQuality({
    target: {
      durationSec: targetDurationSec + cardsSec,
      aspectRatio: render.aspectRatio as AspectRatio,
    },
    probe,
    blackIntervals,
    loudnessLufs,
    contentSafety,
    sync: sync.checks,
  });
}

export function summarise(results: Array<{ platform: string; checks: QualityCheck[] }>): string {
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
  if (pendingSafetyReview(project.metadata))
    return log.info('run is waiting for a content-safety review; skipped');

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

  // 13.25: long renders go to Hive's async API first. While any scan is outstanding the run
  // stays QUALITY_CHECKING; the Hive callback (or the timeout job) re-runs this gate.
  const asyncOutcomes = new Map<string, QualityInputs['contentSafety']>();
  let awaiting = 0;
  for (const render of renders.filter((r) =>
    usesAsyncHiveScan(r.durationSec, deps.config.hiveApiVersion),
  )) {
    const url = await deps.storage.signedUrl(render.s3Bucket, render.s3Key);
    const outcome = await asyncContentSafety(deps, data, render, url);
    if ('pending' in outcome) awaiting += 1;
    else asyncOutcomes.set(render.id, outcome);
  }
  if (awaiting > 0) return log.info({ awaiting }, 'waiting for async content-safety callbacks');

  const results = await Promise.all(
    renders.map(async (render) => {
      const target = scripts.get(render.scriptId)?.targetDurationSec ?? render.durationSec;
      const checks = await checkRender(
        deps,
        data,
        render,
        target,
        project,
        asyncOutcomes.get(render.id),
      );
      await deps.db.videoRender.update({
        where: { id: render.id },
        data: {
          qualityCheckState: qualityPassed(checks) ? 'PASSED' : 'FAILED',
          qualityIssues: checks as unknown as Prisma.InputJsonValue,
        },
      });
      return { renderId: render.id, platform: render.targetPlatform, checks };
    }),
  );

  const allPassed = results.every((r) => qualityPassed(r.checks));
  const blocked = results.some((r) => hasContentSafetyBlock(r.checks));
  // 13.17: a review-level content-safety flag (and nothing block-level) pauses the run for a
  // Trust & Safety decision; the project stays QUALITY_CHECKING until staff decide.
  const flagged = results.flatMap((r) => {
    const check = contentSafetyReviewCheck(r.checks);
    return check ? [{ renderId: r.renderId, platform: r.platform, detail: check.detail }] : [];
  });
  if (!blocked && flagged.length > 0) {
    await openSafetyReview(deps, {
      organisationId: data.organisationId,
      projectId: project.id,
      runId: data.runId,
      planTier: data.planTier,
      kind: 'content',
      reason: flagged.map((f) => `${f.platform}: ${f.detail}`).join('; '),
      details: flagged,
      renderIds: flagged.map((f) => f.renderId),
    });
    return log.warn({ flagged: flagged.length }, 'quality gate paused for a content-safety review');
  }
  const moved = await transitionProject(deps.db, {
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
  // 15.D9: quality pass rate (spec 3.5) and generate → READY_FOR_REVIEW (spec 17.1).
  recordQualityGateOutcome({
    project,
    passed: results.map((r) => qualityPassed(r.checks)),
    moved,
    now: deps.now(),
  });
  // Spec 5.9 review checkpoint: AUTO_APPROVE projects of trusted creators skip the human step.
  if (moved && allPassed) await autoApproveIfTrusted(deps, data);
  // Spec 14.4 "Generation complete" (after auto-approval, so the wording matches the state).
  if (moved && allPassed) await notifyGenerationComplete(deps, data);
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
