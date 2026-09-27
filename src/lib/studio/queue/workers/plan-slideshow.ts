import type { VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  failProject,
  mergeProjectMetadata,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { applyTemplateOverlayDefaults } from '../../slideshow/slide-overlays';
import { jsonOutput, runProvider } from '../../pipeline/provider-run';
import {
  blocksGeneration,
  buildScriptSafetyPrompt,
  parseScriptSafety,
  SCRIPT_SAFETY_SCHEMA,
  SCRIPT_SAFETY_SYSTEM_PROMPT,
} from '../../pipeline/script-safety';
import { parseTargetFormats } from '../../pipeline/scripting';
import { parseSlideContent, slideProblem, type SlideContent } from '../../slideshow/planner';
import { jobIds } from '../enqueue';
import type { ProjectJobData } from '../queues';

// BACKLOG 7.6 — the "plan" step of a SLIDESHOW run. The slides are the plan, so Layers 1–4 are
// skipped (A5.6: slideshows skip Layer 3): check every slide is renderable, run the same
// pre-generation text-safety gate as scripted videos, create one script row per target format
// (renders reference a script; its text is the slides' text), then go straight to composition.

const SAFETY_MAX_TOKENS = 1_000;

export function slideText(content: SlideContent): string[] {
  return [
    content.text,
    content.caption,
    content.quote,
    content.author,
    content.value && content.label ? `${content.value} ${content.label}` : undefined,
    content.name,
    ...(content.features ?? []),
    content.price,
  ].filter((t): t is string => Boolean(t));
}

/** 13.4: the template's overlayDefaults, applied at the first generation only. */
async function applyOverlayDefaultsOnce(
  deps: PipelineDeps,
  project: VideoProject,
  runId: string,
  log: Logger,
): Promise<void> {
  const metadata = projectMetadata(project.metadata);
  if (metadata.slideOverlayDefaultsApplied === true) return;
  const templateId = (metadata.slideshow as { templateId?: unknown } | undefined)?.templateId;
  const brandKit = await deps.db.brandKit.findFirst({
    where: project.brandKitId
      ? { id: project.brandKitId, organisationId: project.organisationId }
      : { organisationId: project.organisationId, businessId: project.businessId, isDefault: true },
  });
  const created = await applyTemplateOverlayDefaults(deps.db, {
    projectId: project.id,
    templateId: typeof templateId === 'string' ? templateId : null,
    brandKit,
  });
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId,
    patch: { slideOverlayDefaultsApplied: true },
  });
  if (created) log.info({ overlays: created }, 'template overlay defaults applied to slides');
}

export async function planSlideshow(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  log: Logger,
): Promise<void> {
  const slides = await deps.db.slideshowSlide.findMany({
    where: { projectId: project.id },
    orderBy: { sortOrder: 'asc' },
  });
  const problems = slides.flatMap((s) => {
    const problem = slideProblem({ ...s, metadata: parseSlideContent(s.metadata) });
    return problem ? [`slide ${s.sortOrder + 1}: ${problem}`] : [];
  });
  if (slides.length === 0 || problems.length > 0) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: `slideshow_incomplete: ${slides.length === 0 ? 'no slides' : problems.join('; ')}`,
    });
    return log.warn({ problems }, 'slideshow not renderable');
  }

  const texts = slides.flatMap((s) => slideText(parseSlideContent(s.metadata)));
  const formats = parseTargetFormats(project.targetFormats);
  if (texts.length > 0) {
    const safetyRun = await runProvider(
      {
        need: { kind: 'capability', capability: 'text_generation' },
        planTier: data.planTier,
        request: {
          capability: 'text_generation',
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
    if (blocksGeneration(safety)) {
      await failProject(deps.db, {
        projectId: project.id,
        runId: data.runId,
        reason: `script_safety_${safety.verdict.toLowerCase()}: ${safety.reason}`,
      });
      return log.warn({ safety }, 'slideshow text safety stopped the run');
    }
  }

  await applyOverlayDefaultsOnce(deps, project, data.runId, log);

  const durationSec = Math.max(1, Math.round(slides.reduce((sum, s) => sum + s.durationSec, 0)));
  await deps.db.$transaction(async (tx) => {
    await tx.textOverlay.deleteMany({ where: { shot: { script: { projectId: project.id } } } });
    await tx.videoShot.deleteMany({ where: { script: { projectId: project.id } } });
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    for (const format of formats) {
      await tx.videoScript.create({
        data: {
          projectId: project.id,
          targetPlatform: format.platform,
          targetAspectRatio: format.aspectRatio,
          targetDurationSec: durationSec,
          fullText: texts.join('\n').slice(0, 20_000),
          scriptModel: 'slideshow',
        },
      });
    }
  });
  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  await deps.queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
  log.info({ slides: slides.length, formats: formats.length }, 'slideshow planned; composing');
}
