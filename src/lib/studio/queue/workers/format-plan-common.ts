import type { VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
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
import { parseTargetFormats } from '../../pipeline/scripting';
import {
  generateSlideshowCopy,
  loadCopyContext,
  routedGenerator,
} from '../../services/caption-suggestions';
import type { FormatCopyContext } from '../../formats/copy-prompt';
import type { ProjectJobData } from '../queues';
import type { TextTask } from '../../providers/text-tasks';
import { enqueueComposeIfReady } from './generate-asset';
import { enqueueShots, loadBrandKit, textRequest } from './plan-project';

// BACKLOG 22.1 / 22.2 — the steps the two Fastlane-style formats share in their "plan" job
// (plan-hook-demo.ts, plan-wall-of-text.ts): the brand and business context for the copy prompt,
// one Claude call through the router, the same pre-generation text-safety gate as slideshows
// (spec 13.2; a BLOCK fails the run before any visual spend), per-platform captions and hashtags
// (20.13, non-fatal), and the hand-off to Layer 3 / composition.

const SAFETY_MAX_TOKENS = 1_000;
export const FORMAT_COPY_MAX_TOKENS = 600;

/** The copy prompt's context: brief, language, business facts, brand voice, restricted topics. */
export async function formatCopyContext(
  deps: PipelineDeps,
  project: VideoProject,
  log: Logger,
): Promise<FormatCopyContext> {
  const kit = await loadBrandKit(deps, project);
  let copy: Awaited<ReturnType<typeof loadCopyContext>> | null = null;
  try {
    copy = await loadCopyContext(deps.db, project, deps.now());
  } catch (err) {
    log.warn({ err }, 'business facts unavailable; the copy is written from the brief alone');
  }
  return {
    brief: project.description?.trim() ?? '',
    language: project.language || 'en-GB',
    facts: {
      businessName: copy?.facts.businessName ?? null,
      industry: copy?.facts.industry ?? null,
      subNiche: copy?.facts.subNiche ?? null,
      products: copy?.facts.products ?? [],
      services: copy?.facts.services ?? [],
      regions: copy?.facts.regions ?? [],
      audience: copy?.facts.audienceKeywords ?? [],
    },
    voice: kit?.toneKeywords ?? [],
    audienceProfile: kit?.audienceProfile ?? null,
    restrictedTopics: [
      ...new Set([...(kit?.restrictedTopics ?? []), ...(copy?.restrictedTopics ?? [])]),
    ],
  };
}

/** One structured Claude call (text_generation through the router). */
export async function writeCopy(
  deps: PipelineDeps,
  data: ProjectJobData,
  /** 23.2: task = hook_line or wall_text (light tasks, providers/text-tasks.ts). */
  input: { system: string; prompt: string; schema: object; task: TextTask },
): Promise<unknown> {
  const run = await runProvider(
    textRequest(data, input.system, input.prompt, input.schema, FORMAT_COPY_MAX_TOKENS, input.task),
    deps,
  );
  return jsonOutput(run.output);
}

/** The pre-generation text-safety gate on the on-screen text. False = the run was stopped. */
export async function passesTextSafety(
  deps: PipelineDeps,
  data: ProjectJobData,
  project: VideoProject,
  texts: string[],
  log: Logger,
): Promise<boolean> {
  const formats = parseTargetFormats(project.targetFormats);
  const safetyRun = await runProvider(
    {
      need: { kind: 'capability', capability: 'text_generation' },
      planTier: data.planTier,
      request: {
        capability: 'text_generation',
        task: 'script_safety',
        organisationId: data.organisationId,
        projectId: data.projectId,
        system: SCRIPT_SAFETY_SYSTEM_PROMPT,
        prompt: buildScriptSafetyPrompt(
          formats.map((f) => ({
            platform: f.platform,
            fullText: texts.join('\n'),
            onScreenText: texts,
          })),
        ),
        outputSchema: SCRIPT_SAFETY_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: SAFETY_MAX_TOKENS,
      },
    },
    deps,
  );
  const safety = parseScriptSafety(jsonOutput(safetyRun.output));
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId: data.runId,
    patch: { scriptSafety: safety },
  });
  if (!blocksGeneration(safety)) return true;
  await failProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    reason: `script_safety_${safety.verdict.toLowerCase()}: ${safety.reason}`,
  });
  log.warn({ safety }, 'on-screen text stopped by the safety gate');
  return false;
}

/** 20.13: captions and hashtags per platform from the on-screen text (never stops the run). */
export async function storeFormatCopy(
  deps: PipelineDeps,
  data: ProjectJobData,
  project: VideoProject,
  texts: string[],
  log: Logger,
): Promise<void> {
  try {
    await generateSlideshowCopy(
      {
        db: deps.db,
        now: deps.now,
        generate: routedGenerator(deps, {
          organisationId: data.organisationId,
          projectId: data.projectId,
          planTier: data.planTier,
        }),
      },
      project,
      texts,
    );
  } catch (err) {
    log.warn({ err }, 'captions not generated; publishing will top up the hashtags');
  }
}

/**
 * PLANNING → ASSETS_QUEUED, then one generate-asset job per shot still to make, or straight to
 * composition when every shot is already READY (a demo, a library clip).
 */
export async function startAssets(deps: PipelineDeps, data: ProjectJobData): Promise<number> {
  await transitionProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  return resumeAssets(deps, data);
}

/** Re-enqueue the shots still to make, or composition once every shot is done (idempotent ids). */
export async function resumeAssets(deps: PipelineDeps, data: ProjectJobData): Promise<number> {
  const queued = await enqueueShots(deps, data);
  if (queued === 0) await enqueueComposeIfReady(deps, data);
  return queued;
}
