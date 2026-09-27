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
import { ensureWordTiming } from '../../pipeline/word-timing';
import { captionLines, captionRows } from '../../overlays/captions';
import { BUILT_IN_PRESETS } from '../../overlays/presets';
import { jobIds } from '../enqueue';
import type { ProjectJobData } from '../queues';
import { loadBrandKit } from './plan-project';

// Phase 13.5 — the "plan" step of an UPLOAD run. The owner's video is the footage, so Layers 1–3
// (ideation, script, asset generation) and Layer 4 (voice) are skipped. The video's speech is
// transcribed (AssemblyAI, pipeline/word-timing.ts) for captions and the same pre-generation
// text-safety gate as scripted videos; then one script per target format is created with a
// single USER_UPLOAD shot (trimmed to the format's duration) carrying caption overlays, and the
// run goes straight to composition → multi-format render → quality gate, like every video.

const SAFETY_MAX_TOKENS = 1_000;

export async function planUpload(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  log: Logger,
): Promise<void> {
  const upload = project.sourceRef
    ? await deps.db.videoUpload.findFirst({
        where: { id: project.sourceRef, organisationId: project.organisationId },
      })
    : null;
  const asset = upload?.assetId
    ? await deps.db.videoAsset.findFirst({
        where: { id: upload.assetId, organisationId: project.organisationId, kind: 'VIDEO_CLIP' },
      })
    : null;
  if (!upload || upload.state !== 'READY' || !asset?.durationSec) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: 'upload_missing: the uploaded video is not available',
    });
    return log.warn({ uploadId: project.sourceRef }, 'upload missing; project failed');
  }

  const timing = await ensureWordTiming(deps, {
    assetId: asset.id,
    organisationId: project.organisationId,
    planTier: data.planTier,
  });
  const words = timing?.status === 'ok' ? timing.words : [];
  const transcript = words.map((w) => w.text).join(' ');
  const formats = parseTargetFormats(project.targetFormats);

  if (transcript.trim()) {
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
            formats.map((f) => ({ platform: f.platform, fullText: transcript, onScreenText: [] })),
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
      return log.warn({ safety }, 'uploaded video speech stopped by the safety gate');
    }
  }

  const brandKit = await loadBrandKit(deps, project);
  const palette = Array.isArray(brandKit?.colourPalette)
    ? (brandKit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const brand = brandKit
    ? { primary: palette[0], secondary: palette[1], fontFamily: brandKit.fontPrimary ?? undefined }
    : null;
  const videoSec = asset.durationSec;
  await deps.db.$transaction(async (tx) => {
    await tx.textOverlay.deleteMany({ where: { shot: { script: { projectId: project.id } } } });
    await tx.videoShot.deleteMany({ where: { script: { projectId: project.id } } });
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    const presets = await tx.overlayPreset.findMany({
      where: { scope: 'BUILT_IN', name: { in: BUILT_IN_PRESETS.map((p) => p.name) } },
      select: { id: true, name: true },
    });
    const presetIdByName = new Map(presets.map((p) => [p.name, p.id]));
    for (const format of formats) {
      // A format shorter than the video uses its opening; the render never exceeds the video.
      const durationSec = Math.round(Math.min(videoSec, format.durationSec) * 1000) / 1000;
      const script = await tx.videoScript.create({
        data: {
          projectId: project.id,
          targetPlatform: format.platform,
          targetAspectRatio: format.aspectRatio,
          targetDurationSec: Math.max(1, Math.round(durationSec)),
          fullText: transcript.slice(0, 20_000),
          scriptModel: 'upload',
          shots: {
            create: {
              sortOrder: 0,
              durationSec,
              visualTreatment: 'USER_UPLOAD',
              sceneDescription: `Uploaded video: ${upload.fileName}`.slice(0, 500),
              assetId: asset.id,
              transitionOut: 'cut',
              state: 'READY',
            },
          },
        },
        include: { shots: true },
      });
      const shot = script.shots[0];
      if (!shot) continue;
      const rows = captionRows(shot.id, captionLines(words, durationSec), brand, presetIdByName);
      if (rows.length) await tx.textOverlay.createMany({ data: rows });
    }
  });
  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  await deps.queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
  log.info(
    { formats: formats.length, words: words.length, timing: timing?.status ?? 'none' },
    'uploaded video planned; composing',
  );
}
