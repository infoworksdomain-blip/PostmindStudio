import type { Prisma, VideoRender } from '@prisma/client';
import { NoProviderAvailableError, NotFoundError, ProviderError } from '../../../errors';
import type { ContentSafetyScan } from '../../providers/content-safety';
import type { AspectRatio } from '../../providers/interface';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  currentRunId,
  failProject,
  mergeProjectMetadata,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { runProvider } from '../../pipeline/provider-run';
import { planCandidates } from '../../providers/router';
import {
  BLACK_FRAME_MAX_SEC,
  contentSafetyReviewCheck,
  evaluateQuality,
  hasContentSafetyBlock,
  qualityPassed,
  summarise,
  type ContentSafetyState,
  type QualityCheck,
  type QualityInputs,
} from '../../pipeline/quality-checks';
import type { ProjectJobData } from '../queues';
import { autoApproveIfTrusted } from '../../automation/auto-approve';
import { notifyGenerationComplete } from '../../notifications/events';
import { openSafetyReview, pendingSafetyReview } from '../../pipeline/safety-review';
import { releaseNoProviderSafetyReview } from '../../services/safety-reviews';
import { recordQualityGateOutcome } from '../../observability/slo';
import { renderSyncChecks } from '../../pipeline/quality-brand-gate';

// BACKLOG 3.7 — Layer 8 (spec 5.9 / 13.1). Every render of the run is measured with ffprobe /
// ffmpeg, scanned for content safety when a content-safety provider exists, and evaluated
// fail-closed. All pass → READY_FOR_REVIEW; otherwise QUALITY_FAILED with the reasons
// (force-approve for non-block failures is a Phase 4 API with the studio:render:force-approve
// capability).
//
// 20.21 (operator decision 2026-10-02, "remove Hive from dependency completely"): no
// content-safety provider is built, so the scan is skipped ("Not scanned") and the run continues
// to the normal review. No Trust & Safety review is opened for a missing provider, nothing is
// blocked and no operator alert is sent.

async function scanContentSafety(
  deps: PipelineDeps,
  data: ProjectJobData,
  render: VideoRender,
  url: string,
): Promise<QualityInputs['contentSafety']> {
  const need = { kind: 'capability', capability: 'content_safety' } as const;
  // No candidate at all (today: none is built) → skip without routing, so a cost-cap pause or a
  // kill switch cannot fail a check that would not have run anyway.
  if (planCandidates(need, data.planTier).providerIds.length === 0)
    return { skipped: 'no_provider' };
  try {
    const run = await runProvider(
      {
        need,
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
    // Transient provider trouble → retry the job.
    if (err instanceof ProviderError && err.retryable) throw err;
    // 20.21: no content-safety provider (none is built today; or a future one is not configured
    // or held) → not scanned; the run continues to the normal review.
    if (err instanceof NoProviderAvailableError) return { skipped: 'no_provider' };
    // A configured provider that answered with a non-retryable error → fail closed (block).
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
) {
  const url = await deps.storage.signedUrl(render.s3Bucket, render.s3Key);
  const [probe, blackIntervals, loudnessLufs, contentSafety] = await Promise.all([
    deps.media.probe(url),
    deps.media.blackIntervals(url, BLACK_FRAME_MAX_SEC),
    deps.media.integratedLoudness(url),
    scanContentSafety(deps, data, render, url),
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

const isSkippedSafety = (c: QualityCheck) => c.code === 'content_safety' && c.status === 'not_run';

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
  const pendingReview = pendingSafetyReview(project.metadata);
  if (pendingReview) {
    // 20.21: a review 20.19 opened only because no content-safety provider existed is released
    // (the renders are recorded as not scanned) instead of waiting for staff.
    const released = await releaseNoProviderSafetyReview(deps, pendingReview.id, {
      afterReady: (job) => autoApproveIfTrusted(deps, job),
    });
    if (released === 'released') return log.info('no-provider safety hold released');
    return log.info('run is waiting for a content-safety review; skipped');
  }

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
      const checks = await checkRender(deps, data, render, target, project);
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

  // 20.21: record that the run's renders were not scanned (staff/admin read it; customers do not).
  if (results.some((r) => r.checks.some(isSkippedSafety))) {
    const contentSafety: ContentSafetyState = { state: 'skipped', reason: 'no_provider' };
    await mergeProjectMetadata(deps.db, {
      projectId: project.id,
      runId: data.runId,
      patch: { contentSafety },
    });
  }
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
