import type { BrandKit, Prisma, VideoProject, VideoShot } from '@prisma/client';
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
import { openSafetyReview, pendingSafetyReview } from '../../pipeline/safety-review';
import {
  blocksGeneration,
  buildScriptSafetyPrompt,
  needsSafetyReview,
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
import { styleMemorySupplement } from '../../services/style-memory';
import { projectLanguages } from '../../languages';
import { jobIds } from '../enqueue';
import { planSlideshow } from './plan-slideshow';
import { planUpload } from './plan-upload';
import { regenerateScriptPlan } from './regenerate-script';
import { scriptRegeneration } from '../../services/scripts';
import { loadReferenceGuide, type ReferenceGuide } from '../../library/reference';
import { loadTemplateGuide } from '../../templates/blueprint';
import { suggestionRows, suggestOverlays } from '../../overlays/suggest';
import { BUILT_IN_PRESETS } from '../../overlays/presets';
import type { ProjectJobData } from '../queues';

// BACKLOG 3.4 — Layers 1 (ideation) and 2 (script + storyboard), then pre-generation script
// safety (spec 13.2), persistence of briefs/scripts/shots, and fan-out of one generate-asset job
// per shot (spec 4.5 step 3).

const IDEATION_MAX_TOKENS = 4_000;
const SCRIPT_MAX_TOKENS = 8_000;
const SAFETY_MAX_TOKENS = 1_000;
const SUPPORTED_SOURCES = new Set(['BRIEF', 'POSTMIND_CONTENT', 'LIBRARY_REFERENCE', 'TEMPLATE']);

export function modelLabel(run: ProviderRunResult): string {
  const model = (run.output.metadata as { model?: string } | undefined)?.model;
  return `${run.decision.providerId}:${model ?? 'unknown'}`;
}

export async function loadBrandKit(
  deps: PipelineDeps,
  project: VideoProject,
): Promise<BrandKit | null> {
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

export function textRequest(
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

export async function enqueueShots(deps: PipelineDeps, data: ProjectJobData): Promise<number> {
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
  scripts: Array<{ format: TargetFormat; plan: PlannedScript; model: string; language?: string }>,
  brandKit: BrandKit | null,
  reference: ReferenceGuide | null = null,
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
    for (const { format, plan, model, language } of scripts) {
      await tx.videoScript.create({
        data: {
          projectId: project.id,
          targetPlatform: format.platform,
          targetAspectRatio: format.aspectRatio,
          targetDurationSec: Math.round(format.durationSec),
          // 15.C5: the script's language (the project's, or one of its extra languages).
          ...(language && { language }),
          fullText: plan.fullText,
          scriptModel: model,
          shots: { create: plan.shots.map((shot) => ({ ...shot, state: 'QUEUED' as const })) },
        },
      });
    }
    // Layer 2 also proposes styled overlays for every shot's on-screen text (A4.5).
    const shots = await tx.videoShot.findMany({ where: { script: { projectId: project.id } } });
    await createSuggestedOverlays(tx, shots, brandKit, reference);
  });
}

/** Proposed overlays for these shots' on-screen text, grouped per script (A4.5). */
export async function createSuggestedOverlays(
  tx: Prisma.TransactionClient,
  shots: VideoShot[],
  brandKit: BrandKit | null,
  reference: ReferenceGuide | null,
): Promise<void> {
  const presets = await tx.overlayPreset.findMany({
    where: { scope: 'BUILT_IN', name: { in: BUILT_IN_PRESETS.map((p) => p.name) } },
    select: { id: true, name: true },
  });
  const palette = Array.isArray(brandKit?.colourPalette)
    ? (brandKit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const brand = brandKit
    ? {
        primary: palette[0],
        secondary: palette[1],
        fontFamily: brandKit.fontPrimary ?? undefined,
      }
    : null;
  const rows = [...new Set(shots.map((s) => s.scriptId))].flatMap((scriptId) =>
    suggestionRows(
      suggestOverlays(
        shots.filter((s) => s.scriptId === scriptId),
        brand,
        reference ? (index) => reference.presetForShot(index) : undefined,
      ),
      new Map(presets.map((p) => [p.name, p.id])),
    ),
  );
  if (rows.length) await tx.textOverlay.createMany({ data: rows });
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
  if (pendingSafetyReview(project.metadata))
    return log.info('run is waiting for a content-safety review; skipped');

  // Resume: plan already persisted by an earlier attempt; only the fan-out may be missing.
  if (
    project.state === 'ASSETS_QUEUED' &&
    (project.sourceType === 'SLIDESHOW' || project.sourceType === 'UPLOAD')
  ) {
    await deps.queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
    return log.info('slideshow/upload already planned; composition re-enqueued');
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
  // Phase 13.5: an uploaded video skips Layers 1–3 (plan-upload.ts).
  if (project.sourceType === 'UPLOAD') return planUpload(data, deps, project, log);
  // Phase 13.1: POST /scripts/:id/regenerate — Layer 2 only, reusing the stored brief.
  const regeneration = scriptRegeneration(project.metadata, data.runId);
  if (regeneration) return regenerateScriptPlan(data, deps, project, regeneration, log);
  if (!SUPPORTED_SOURCES.has(project.sourceType)) {
    throw new NotImplementedError(`Planning for sourceType ${project.sourceType} is not built yet`);
  }
  const briefText =
    project.description?.trim() || String(projectMetadata(project.metadata).brief ?? '').trim();
  if (!briefText) throw new ValidationError('Project has no brief text (description)');
  // Feature A: a reference video's blueprint (TEMPLATE) or style (INSPIRE) shapes Layers 1–2;
  // a project template's shot blueprint shapes Layer 2 the same way (spec 7.12 / 8.6).
  const reference =
    (await loadReferenceGuide(deps.db, project, deps.now())) ??
    (await loadTemplateGuide(deps.db, project));
  const rawInput = reference?.ideationSupplement
    ? `${briefText}\n\n${reference.ideationSupplement}`
    : briefText;
  const formats = parseTargetFormats(project.targetFormats);
  const brandKit = await loadBrandKit(deps, project);
  const restrictedTopics = brandKit?.restrictedTopics ?? [];
  // 13.29: learned preferences (style memory), fenced as data for Layers 1–2.
  const styleMemory = await styleMemorySupplement(
    deps.db,
    project.organisationId,
    project.businessId,
  );

  // Layer 1 — ideation
  const ideationRun = await runProvider(
    textRequest(
      data,
      IDEATION_SYSTEM_PROMPT,
      [
        buildIdeationPrompt({
          rawInput,
          businessName: project.name,
          targetPlatforms: formats.map((f) => f.platform),
          hints: projectMetadata(project.metadata).briefHints as IdeationHints | undefined,
          language: project.language,
          brand: brandKit
            ? {
                toneKeywords: brandKit.toneKeywords,
                audienceProfile: brandKit.audienceProfile,
                restrictedTopics,
              }
            : undefined,
        }),
        styleMemory,
      ]
        .filter(Boolean)
        .join('\n\n'),
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

  // Layer 2 — one script per target format and language (15.C5: extra languages each get a
  // full variant set, written natively in that language).
  const treatments = availableTreatments(deps.registry);
  const languages = projectLanguages(project.language, projectMetadata(project.metadata).languages);
  const variants = languages.flatMap((language) => formats.map((format) => ({ format, language })));
  const scripts = await Promise.all(
    variants.map(async ({ format, language }) => {
      const run = await runProvider(
        textRequest(
          data,
          SCRIPT_SYSTEM_PROMPT,
          [
            buildScriptPrompt({ brief, format, treatments, restrictedTopics, language }),
            reference?.scriptSupplement(format.durationSec, treatments),
            styleMemory,
          ]
            .filter(Boolean)
            .join('\n\n'),
          scriptSchema(treatments),
          SCRIPT_MAX_TOKENS,
        ),
        deps,
      );
      return {
        format,
        language,
        plan: ((plan) => (reference ? reference.apply(plan, format.durationSec) : plan))(
          normaliseScript(jsonOutput(run.output), treatments, format.durationSec),
        ),
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
          platform: `${s.format.platform} (${s.language})`,
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
  if (needsSafetyReview(safety)) {
    // 13.17: pause for a Trust & Safety decision. The plan is stored (no shot is enqueued), so
    // ALLOW continues from here without paying for ideation and scripting again.
    await persistPlan(deps, project, brief, modelLabel(ideationRun), scripts, brandKit, reference);
    await openSafetyReview(deps, {
      organisationId: data.organisationId,
      projectId: project.id,
      runId: data.runId,
      planTier: data.planTier,
      kind: 'script',
      reason: `Script safety REVIEW${safety.categories.length ? ` (${safety.categories.join(', ')})` : ''}: ${safety.reason}`,
      details: { verdict: safety.verdict, categories: safety.categories, reason: safety.reason },
    });
    return log.warn({ safety }, 'script safety paused the run for review');
  }
  if (blocksGeneration(safety)) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: `script_safety_${safety.verdict.toLowerCase()}: ${safety.reason}`,
    });
    return log.warn({ safety }, 'script safety stopped the run');
  }

  await persistPlan(deps, project, brief, modelLabel(ideationRun), scripts, brandKit, reference);
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
