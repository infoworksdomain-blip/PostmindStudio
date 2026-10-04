import type { VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import { ConflictError } from '../../../errors';
import type { IdeationResult } from '../../pipeline/ideation';
import type { PipelineDeps } from '../../pipeline/deps';
import { failProject, mergeProjectMetadata, transitionProject } from '../../pipeline/project-state';
import { jsonOutput, runProvider } from '../../pipeline/provider-run';
import {
  blocksGeneration,
  buildScriptSafetyPrompt,
  parseScriptSafety,
  SCRIPT_SAFETY_SCHEMA,
  SCRIPT_SAFETY_SYSTEM_PROMPT,
} from '../../pipeline/script-safety';
import { isAiShot } from '../../pipeline/clip-budget';
import { scriptLayerMode } from '../../ugc/script-layer';
import {
  buildScriptPrompt,
  mergePinnedShots,
  normaliseScript,
  parseTargetFormats,
  pinnedShotsSupplement,
  type PinnedShotContext,
  SCRIPT_SYSTEM_PROMPT,
  scriptSchema,
  type TargetFormat,
} from '../../pipeline/scripting';
import { loadReferenceGuide } from '../../library/reference';
import { loadTemplateGuide } from '../../templates/blueprint';
import type { ScriptRegeneration } from '../../services/scripts';
import type { ProjectJobData } from '../queues';
import {
  createSuggestedOverlays,
  enqueueShots,
  loadBrandKit,
  modelLabel,
  textRequest,
} from './plan-project';
import { SCRIPT_MAX_TOKENS } from '../../pipeline/token-budgets';

// Phase 13.1 â€” POST /scripts/:id/regenerate (spec 8.4): a new run from Layer 2 for ONE script,
// reusing the Layer 1 brief stored in video_briefs (no ideation spend). The rewrite goes through
// the same pre-generation safety gate, replaces that script's shots and suggested overlays, and
// fans out generate-asset for the new shots; the project's other scripts are untouched and keep
// their renders (services/scripts.ts keeps them in metadata.renders).

const SAFETY_MAX_TOKENS = 1_000;

/** The owner's rewrite instruction, fenced so it reads as data, not as system text. */
export function instructionSupplement(instruction: string | null): string | undefined {
  if (!instruction) return undefined;
  return [
    'The owner asked for this rewrite. Follow it where it does not conflict with the rules above:',
    '"""',
    instruction.replace(/"""/g, '"'),
    '"""',
  ].join('\n');
}

export async function regenerateScriptPlan(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  regeneration: ScriptRegeneration,
  log: Logger,
): Promise<void> {
  const [script, stored] = await Promise.all([
    deps.db.videoScript.findFirst({ where: { id: regeneration.scriptId, projectId: project.id } }),
    deps.db.videoBrief.findUnique({ where: { projectId: project.id } }),
  ]);
  if (!script || !stored) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: 'script_regenerate_failed: the script or its brief no longer exists',
    });
    return log.warn('script regeneration target missing');
  }
  const brief: IdeationResult = {
    actionable: true,
    directionOptions: [],
    hook: stored.hook,
    keyMessage: stored.keyMessage,
    targetAudience: stored.targetAudience,
    tone: stored.tone,
    callToAction: stored.callToAction ?? '',
    keywords: Array.isArray(stored.keywords)
      ? stored.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    restrictedTopicsMentioned: [],
  };
  const configured = parseTargetFormats(project.targetFormats).find(
    (f) => f.platform === script.targetPlatform,
  );
  const format: TargetFormat = {
    platform: script.targetPlatform,
    aspectRatio: script.targetAspectRatio as TargetFormat['aspectRatio'],
    durationSec: configured?.durationSec ?? script.targetDurationSec,
  };
  const brandKit = await loadBrandKit(deps, project);
  const restrictedTopics = brandKit?.restrictedTopics ?? [];
  const reference =
    (await loadReferenceGuide(deps.db, project, deps.now())) ??
    (await loadTemplateGuide(deps.db, project));
  // 21.4: a UGC actor video keeps its style, rules and actor clip budget on a rewrite.
  const mode = scriptLayerMode({
    metadata: project.metadata,
    tier: data.planTier,
    registry: deps.registry,
  });
  const treatments = mode.treatments;
  // 15.C9: pinned shots stay (assets and position); Layer 2 writes only the others.
  const currentShots = await deps.db.videoShot.findMany({
    where: { scriptId: script.id },
    orderBy: { sortOrder: 'asc' },
  });
  const pinned = currentShots
    .map((shot, position) => ({ shot, position }))
    .filter(({ shot }) => regeneration.pinnedShotIds.includes(shot.id));
  const pinnedContext: PinnedShotContext[] = pinned.map(({ shot, position }) => ({
    position,
    durationSec: shot.durationSec,
    sceneDescription: shot.sceneDescription,
    voiceoverText: shot.voiceoverText,
    onScreenText: shot.onScreenText,
  }));
  const pinnedSec = pinned.reduce((sum, p) => sum + p.shot.durationSec, 0);
  const writeSec = Math.max(1, format.durationSec - pinnedSec);
  // 20.25: pinned AI shots spend the script's AI clip budget first; the rewrite gets the rest.
  const pinnedAi = pinned.filter((p) =>
    mode.ugc ? p.shot.visualTreatment === 'UGC_ACTOR' : isAiShot(p.shot.visualTreatment),
  ).length;
  const budget = Math.max(0, mode.budget(format.durationSec) - pinnedAi);

  // Layer 2 only
  const run = await runProvider(
    textRequest(
      data,
      SCRIPT_SYSTEM_PROMPT,
      [
        buildScriptPrompt({
          brief,
          format,
          treatments,
          restrictedTopics,
          language: script.language,
          aiClipBudget: mode.ugc ? undefined : budget,
        }),
        reference?.scriptSupplement(format.durationSec, treatments),
        mode.supplement(format.durationSec, budget),
        pinnedShotsSupplement(pinnedContext, format.durationSec),
        instructionSupplement(regeneration.instruction),
      ]
        .filter(Boolean)
        .join('\n\n'),
      scriptSchema(treatments),
      SCRIPT_MAX_TOKENS,
    ),
    deps,
  );
  const normalised = normaliseScript(jsonOutput(run.output), treatments, writeSec);
  const templated = reference && pinned.length === 0;
  const written = mode.apply(
    templated ? reference.apply(normalised, format.durationSec) : normalised,
    {
      budget,
      targetSec: templated ? format.durationSec : writeSec,
      keepDurations: Boolean(templated && reference.blueprint),
    },
  ).plan;
  const merged = mergePinnedShots(written.shots, pinned);
  const texts = merged.map((m) => (m.kind === 'pinned' ? m.shot.shot : m.shot));
  const plan = {
    fullText:
      pinned.length === 0
        ? written.fullText
        : texts
            .map((s) => s.voiceoverText ?? '')
            .filter(Boolean)
            .join(' '),
    shots: texts,
  };

  // Pre-generation safety gate â€” before any Layer 3 spend
  const safetyRun = await runProvider(
    textRequest(
      data,
      SCRIPT_SAFETY_SYSTEM_PROMPT,
      buildScriptSafetyPrompt([
        {
          platform: format.platform,
          fullText: plan.fullText,
          onScreenText: plan.shots.flatMap((s) => (s.onScreenText ? [s.onScreenText] : [])),
        },
      ]),
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
    return log.warn({ safety }, 'script safety stopped the rewrite');
  }

  await deps.db.$transaction(async (tx) => {
    const current = await tx.videoProject.findUnique({
      where: { id: project.id },
      select: { metadata: true },
    });
    const runId = (current?.metadata as { runId?: unknown } | null)?.runId;
    if (runId !== data.runId) throw new ConflictError('Run superseded');
    const keep = pinned.map((p) => p.shot.id);
    await tx.textOverlay.deleteMany({
      where: { shot: { scriptId: script.id }, shotId: { notIn: keep } },
    });
    await tx.videoShot.deleteMany({ where: { scriptId: script.id, id: { notIn: keep } } });
    await tx.videoScript.update({
      where: { id: script.id },
      data: { fullText: plan.fullText, scriptModel: modelLabel(run), version: { increment: 1 } },
    });
    const created: string[] = [];
    for (const [sortOrder, entry] of merged.entries()) {
      if (entry.kind === 'pinned') {
        // A pinned shot keeps its assets; one that never finished is generated again.
        await tx.videoShot.update({
          where: { id: entry.shot.shot.id },
          data: {
            sortOrder,
            ...(entry.shot.shot.state !== 'READY' && { state: 'QUEUED', errorReason: null }),
          },
        });
      } else {
        const row = await tx.videoShot.create({
          data: { ...entry.shot, sortOrder, scriptId: script.id, state: 'QUEUED' },
        });
        created.push(row.id);
      }
    }
    const shots = await tx.videoShot.findMany({ where: { id: { in: created } } });
    await createSuggestedOverlays(tx, shots, brandKit, reference);
  });
  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  const count = await enqueueShots(deps, data);
  log.info({ scriptId: script.id, shots: count }, 'script rewritten from Layer 2; assets enqueued');
}
