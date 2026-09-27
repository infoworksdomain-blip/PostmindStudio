import type { BrandKit, Prisma, VideoProject } from '@prisma/client';
import { NotFoundError, NotImplementedError, ValidationError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  buildIdeationPrompt,
  IDEATION_SCHEMA,
  IDEATION_SYSTEM_PROMPT,
  parseIdeationResult,
  type IdeationContext,
  type IdeationResult,
} from '../../pipeline/ideation';

type IdeationHints = IdeationContext['hints'];
import {
  currentRunId,
  failProject,
  mergeProjectMetadata,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { jsonOutput, runProvider, type ProviderRunResult } from '../../pipeline/provider-run';
import {
  blocksGeneration,
  buildScriptSafetyPrompt,
  parseScriptSafety,
  SCRIPT_SAFETY_SCHEMA,
  SCRIPT_SAFETY_SYSTEM_PROMPT,
} from '../../pipeline/script-safety';
import {
  availableTreatments,
  buildScriptPrompt,
  normaliseScript,
  parseTargetFormats,
  SCRIPT_SYSTEM_PROMPT,
  scriptSchema,
  type PlannedScript,
  type TargetFormat,
} from '../../pipeline/scripting';
import { jobIds } from '../enqueue';
import { planSlideshow } from './plan-slideshow';
import type { ProjectJobData } from '../queues';

// BACKLOG 3.4 — Layers 1 (ideation) and 2 (script + storyboard), then pre-generation script
// safety (spec 13.2), persistence of briefs/scripts/shots, and fan-out of one generate-asset job
// per shot (spec 4.5 step 3).

const IDEATION_MAX_TOKENS = 4_000;
const SCRIPT_MAX_TOKENS = 8_000;
const SAFETY_MAX_TOKENS = 1_000;
const SUPPORTED_SOURCES = new Set(['BRIEF', 'POSTMIND_CONTENT']);

function modelLabel(run: ProviderRunResult): string {
  const model = (run.output.metadata as { model?: string } | undefined)?.model;
  return `${run.decision.providerId}:${model ?? 'unknown'}`;
}

async function loadBrandKit(deps: PipelineDeps, project: VideoProject): Promise<BrandKit | null> {
  if (project.brandKitId) {
    return deps.db.brandKit.findFirst({
      where: { id: project.brandKitId, organisationId: project.organisationId },
    });
  }
  return deps.db.brandKit.findFirst({
    where: {
      organisationId: project.organisationId,
      businessId: project.businessId,
      isDefault: true,
    },
  });
}

function textRequest(
  data: ProjectJobData,
  system: string,
  prompt: string,
  schema: object,
  maxTokens: number,
) {
  return {
    need: { kind: 'capability' as const, capability: 'text_generation' as const },
    planTier: data.planTier,
    request: {
      capability: 'text_generation' as const,
      organisationId: data.organisationId,
      projectId: data.projectId,
      system,
      prompt,
      outputSchema: schema as Record<string, unknown>,
      maxTokens,
    },
  };
}

async function enqueueShots(deps: PipelineDeps, data: ProjectJobData): Promise<number> {
  const shots = await deps.db.videoShot.findMany({
    where: { script: { projectId: data.projectId }, state: { in: ['PLANNED', 'QUEUED'] } },
    select: { id: true },
    orderBy: [{ scriptId: 'asc' }, { sortOrder: 'asc' }],
  });
  for (const shot of shots) {
    const job = { ...data, shotId: shot.id };
    await deps.queue.add('generate-asset', job, { jobId: jobIds.generateAsset(job) });
  }
  return shots.length;
}

async function persistPlan(
  deps: PipelineDeps,
  project: VideoProject,
  brief: IdeationResult,
  ideationModel: string,
  scripts: Array<{ format: TargetFormat; plan: PlannedScript; model: string }>,
): Promise<void> {
  const briefData = {
    rawInput: project.description ?? '',
    hook: brief.hook,
    keyMessage: brief.keyMessage,
    targetAudience: brief.targetAudience,
    tone: brief.tone,
    callToAction: brief.callToAction || null,
    keywords: brief.keywords as Prisma.InputJsonValue,
    ideationModel,
  };
  await deps.db.$transaction(async (tx) => {
    // A new run replaces the previous plan. Renders from earlier runs are kept as history.
    await tx.textOverlay.deleteMany({ where: { shot: { script: { projectId: project.id } } } });
    await tx.videoShot.deleteMany({ where: { script: { projectId: project.id } } });
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    await tx.videoBrief.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, ...briefData },
      update: briefData,
    });
    for (const { format, plan, model } of scripts) {
      await tx.videoScript.create({
        data: {
          projectId: project.id,
          targetPlatform: format.platform,
          targetAspectRatio: format.aspectRatio,
          targetDurationSec: Math.round(format.durationSec),
          fullText: plan.fullText,
          scriptModel: model,
          shots: { create: plan.shots.map((shot) => ({ ...shot, state: 'QUEUED' as const })) },
        },
      });
    }
  });
}

export async function planProject(data: ProjectJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  const project = await deps.db.videoProject.findUnique({ where: { id: data.projectId } });
  if (!project || project.organisationId !== data.organisationId)
    throw new NotFoundError('Project not found');
  if (currentRunId(project) !== data.runId) return log.info('stale plan-project job ignored');

  // Resume: plan already persisted by an earlier attempt; only the fan-out may be missing.
  if (project.state === 'ASSETS_QUEUED' && project.sourceType === 'SLIDESHOW') {
    await deps.queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
    return log.info('slideshow already planned; composition re-enqueued');
  }
  if (project.state === 'ASSETS_QUEUED') {
    const count = await enqueueShots(deps, data);
    return log.info({ shots: count }, 'plan already persisted; shots re-enqueued');
  }
  if (project.state !== 'PLANNING') {
    const moved = await transitionProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      from: ['QUEUED'],
      to: 'PLANNING',
    });
    if (!moved) return log.info({ state: project.state }, 'project not plannable; skipped');
  }

  if (project.sourceType === 'SLIDESHOW') return planSlideshow(data, deps, project, log);
  if (!SUPPORTED_SOURCES.has(project.sourceType)) {
    throw new NotImplementedError(`Planning for sourceType ${project.sourceType} is not built yet`);
  }
  const rawInput =
    project.description?.trim() || String(projectMetadata(project.metadata).brief ?? '').trim();
  if (!rawInput) throw new ValidationError('Project has no brief text (description)');
  const formats = parseTargetFormats(project.targetFormats);
  const brandKit = await loadBrandKit(deps, project);
  const restrictedTopics = brandKit?.restrictedTopics ?? [];

  // Layer 1 — ideation
  const ideationRun = await runProvider(
    textRequest(
      data,
      IDEATION_SYSTEM_PROMPT,
      buildIdeationPrompt({
        rawInput,
        businessName: project.name,
        targetPlatforms: formats.map((f) => f.platform),
        hints: projectMetadata(project.metadata).briefHints as IdeationHints | undefined,
        brand: brandKit
          ? {
              toneKeywords: brandKit.toneKeywords,
              audienceProfile: brandKit.audienceProfile,
              restrictedTopics,
            }
          : undefined,
      }),
      IDEATION_SCHEMA,
      IDEATION_MAX_TOKENS,
    ),
    deps,
  );
  const brief = parseIdeationResult(jsonOutput(ideationRun.output));

  if (!brief.actionable) {
    await transitionProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      from: ['PLANNING'],
      to: 'DRAFT',
      data: { errorReason: 'brief_too_vague: choose one of the suggested directions' },
    });
    await mergeProjectMetadata(deps.db, {
      projectId: project.id,
      runId: data.runId,
      patch: { directionOptions: brief.directionOptions.slice(0, 3) },
    });
    return log.info('brief too vague; returned direction options to the user');
  }

  const confirmed = projectMetadata(project.metadata).restrictedTopicsConfirmed === true;
  if (brief.restrictedTopicsMentioned.length > 0 && !confirmed) {
    await transitionProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      from: ['PLANNING'],
      to: 'DRAFT',
      data: { errorReason: 'restricted_topics: user confirmation required (spec 13.3)' },
    });
    await mergeProjectMetadata(deps.db, {
      projectId: project.id,
      runId: data.runId,
      patch: { pendingRestrictedTopics: brief.restrictedTopicsMentioned },
    });
    return log.info(
      { topics: brief.restrictedTopicsMentioned },
      'restricted topics need confirmation',
    );
  }

  // Layer 2 — one script per target format
  const treatments = availableTreatments(deps.registry);
  const scripts = await Promise.all(
    formats.map(async (format) => {
      const run = await runProvider(
        textRequest(
          data,
          SCRIPT_SYSTEM_PROMPT,
          buildScriptPrompt({ brief, format, treatments, restrictedTopics }),
          scriptSchema(treatments),
          SCRIPT_MAX_TOKENS,
        ),
        deps,
      );
      return {
        format,
        plan: normaliseScript(jsonOutput(run.output), treatments, format.durationSec),
        model: modelLabel(run),
      };
    }),
  );

  // Pre-generation safety gate — before any Layer 3 spend
  const safetyRun = await runProvider(
    textRequest(
      data,
      SCRIPT_SAFETY_SYSTEM_PROMPT,
      buildScriptSafetyPrompt(
        scripts.map((s) => ({
          platform: s.format.platform,
          fullText: s.plan.fullText,
          onScreenText: s.plan.shots.flatMap((shot) =>
            shot.onScreenText ? [shot.onScreenText] : [],
          ),
        })),
      ),
      SCRIPT_SAFETY_SCHEMA,
      SAFETY_MAX_TOKENS,
    ),
    deps,
  );
  const safety = parseScriptSafety(jsonOutput(safetyRun.output));
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId: data.runId,
    patch: { scriptSafety: safety },
  });
  if (blocksGeneration(safety)) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: `script_safety_${safety.verdict.toLowerCase()}: ${safety.reason}`,
    });
    return log.warn({ safety }, 'script safety stopped the run');
  }

  await persistPlan(deps, project, brief, modelLabel(ideationRun), scripts);
  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  const count = await enqueueShots(deps, data);
  log.info({ scripts: scripts.length, shots: count }, 'plan persisted; assets enqueued');
}

/** Final failure (retries exhausted or unrecoverable): the run cannot continue. */
export async function onPlanProjectFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await failProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    reason: `planning_failed: ${reason}`,
  });
}
