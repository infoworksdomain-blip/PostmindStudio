import type { Prisma, VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import type { PipelineDeps } from '../../pipeline/deps';
import { failProject, mergeProjectMetadata } from '../../pipeline/project-state';
import { parseTargetFormats } from '../../pipeline/scripting';
import {
  builtInPresetId,
  classicOverlayRow,
  HOOK_CAPTION_PRESET,
  hookCaptionStyle,
} from '../../formats/caption-style';
import {
  buildHookLinePrompt,
  HOOK_LINE_OUTPUT_SCHEMA,
  HOOK_LINE_SYSTEM_PROMPT,
  parseHookLine,
} from '../../formats/copy-prompt';
import { findFootageClip, HOOK_LIBRARY_CATEGORIES, type FootageClip } from '../../formats/footage';
import { HOOK_CLIP_KEY, hookClipPrompt } from '../../formats/hook-clip';
import {
  DEMO_MIN_SEC,
  effectiveLayout,
  hookDemoTiming,
  readHookDemo,
  type HookDemoDocument,
} from '../../formats/hook-demo';
import type { ProjectJobData } from '../queues';
import { canMakeSilentHook } from './generate-hook-clip';
import {
  formatCopyContext,
  passesTextSafety,
  startAssets,
  storeFormatCopy,
  writeCopy,
} from './format-plan-common';

// BACKLOG 22.1 — the "plan" step of a HOOK_DEMO run (formats/hook-demo.ts). No ideation or
// storyboard: the hook line is the owner's or one Claude line (≤ 12 words, hook frameworks), it
// passes the same text-safety gate as every video, then each target format gets a two-shot
// script: the hook (a silent reaction clip, generated through the actor route or a licensed
// library clip) carrying ONE on-screen hook line, then the business's demo video (its own
// audio, at the chosen mix). Composition, the quality gate, review and publishing are the
// normal pipeline's.

export const NO_DEMO_REASON = 'no_demo_video: the demo video is not available';

async function hookLineFor(
  deps: PipelineDeps,
  data: ProjectJobData,
  project: VideoProject,
  doc: HookDemoDocument,
  demoName: string | undefined,
  log: Logger,
): Promise<string> {
  if (doc.hookLine) return doc.hookLine;
  const context = await formatCopyContext(deps, project, log);
  const answer = parseHookLine(
    await writeCopy(deps, data, {
      system: HOOK_LINE_SYSTEM_PROMPT,
      prompt: buildHookLinePrompt({ ...context, demoName }),
      schema: HOOK_LINE_OUTPUT_SCHEMA,
    }),
  );
  log.info({ framework: answer.framework }, 'hook line written');
  return answer.hookLine;
}

/** How the hook is made: the AI creator (default) or a licensed library reaction clip. */
async function hookSourceFor(
  deps: PipelineDeps,
  project: VideoProject,
  doc: HookDemoDocument,
  minSec: number,
): Promise<{ kind: 'ai' } | { kind: 'library'; clip: FootageClip } | { kind: 'none' }> {
  const canGenerate = canMakeSilentHook(deps.registry);
  const aspect = parseTargetFormats(project.targetFormats)[0]?.aspectRatio ?? '9:16';
  const library = () =>
    findFootageClip(deps.db, {
      categories: HOOK_LIBRARY_CATEGORIES,
      minSec,
      aspectRatio: aspect,
      seed: project.id,
      now: new Date(deps.now()),
    });
  if (doc.hookSource === 'ai_creator' && canGenerate) return { kind: 'ai' };
  const clip = await library();
  if (clip) return { kind: 'library', clip };
  return canGenerate ? { kind: 'ai' } : { kind: 'none' };
}

export async function planHookDemo(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  log: Logger,
): Promise<void> {
  const doc = readHookDemo(project.metadata);
  const demo = doc
    ? await deps.db.videoAsset.findFirst({
        where: { id: doc.demoAssetId, organisationId: project.organisationId, kind: 'VIDEO_CLIP' },
      })
    : null;
  if (!doc || !demo?.durationSec || demo.durationSec < DEMO_MIN_SEC) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: NO_DEMO_REASON,
    });
    return log.warn({ demoAssetId: doc?.demoAssetId }, 'demo video missing; project failed');
  }
  const demoName = (demo.metadata as { fileName?: unknown } | null)?.fileName
    ?.toString()
    .replace(/\.[a-z0-9]+$/i, '');
  const hookLine = await hookLineFor(deps, data, project, doc, demoName, log);
  if (!(await passesTextSafety(deps, data, project, [hookLine], log))) return;

  const demoSec = demo.durationSec;
  const timingFor = (stacked: boolean) =>
    hookDemoTiming({ targetSec: doc.targetSec, demoDurationSec: demoSec, stacked });
  const source = await hookSourceFor(deps, project, doc, timingFor(false).hookSec);
  if (source.kind === 'none') {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason:
        'hook_clip_unavailable: no AI creator provider is configured and the library has no reaction clip licensed as footage',
    });
    return log.warn('no way to make the hook clip; project failed');
  }
  const formats = parseTargetFormats(project.targetFormats);
  await deps.db.$transaction(async (tx) => {
    await tx.textOverlay.deleteMany({ where: { shot: { script: { projectId: project.id } } } });
    await tx.videoShot.deleteMany({ where: { script: { projectId: project.id } } });
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    const libraryAsset =
      source.kind === 'library'
        ? await tx.videoAsset.create({
            data: {
              organisationId: project.organisationId,
              projectId: project.id,
              kind: 'VIDEO_CLIP',
              source: `library:${source.clip.libraryItemId}`,
              s3Bucket: source.clip.s3Bucket,
              s3Key: source.clip.s3Key,
              durationSec: source.clip.durationSec,
              metadata: { libraryItemId: source.clip.libraryItemId, licenceMode: 'FOOTAGE' },
            },
          })
        : null;
    const hookPresetId = await builtInPresetId(tx, HOOK_CAPTION_PRESET);
    // One generated clip per aspect ratio: the first script of a ratio leads, the rest reuse it.
    const leaders = new Map<string, string>();
    for (const format of formats) {
      const stacked = effectiveLayout(doc.layout, format.aspectRatio) === 'stacked';
      // A stacked demo already plays under the hook: the full-frame part is what is left after it.
      const timing = timingFor(stacked);
      const script = await tx.videoScript.create({
        data: {
          projectId: project.id,
          targetPlatform: format.platform,
          targetAspectRatio: format.aspectRatio,
          targetDurationSec: timing.totalSec,
          language: project.language,
          fullText: hookLine,
          scriptModel: 'hook_demo',
        },
      });
      const leader = leaders.get(format.aspectRatio);
      const hook = await tx.videoShot.create({
        data: {
          scriptId: script.id,
          sortOrder: 0,
          durationSec: timing.hookSec,
          visualTreatment: libraryAsset ? 'STOCK_FOOTAGE' : 'AI_CLIP',
          sceneDescription: hookClipPrompt({ reaction: doc.reaction, actorReference: false }).slice(
            0,
            500,
          ),
          onScreenText: hookLine,
          transitionOut: 'cut',
          ...(libraryAsset
            ? {
                assetId: libraryAsset.id,
                state: 'READY' as const,
                providerRouting: { visual: { providerId: 'video-library' } },
              }
            : {
                state: 'QUEUED' as const,
                providerRouting: {
                  [HOOK_CLIP_KEY]: {
                    reaction: doc.reaction,
                    ...(leader && { leaderShotId: leader }),
                  },
                } as Prisma.InputJsonValue,
              }),
        },
      });
      if (!libraryAsset && !leader) leaders.set(format.aspectRatio, hook.id);
      await tx.videoShot.create({
        data: {
          scriptId: script.id,
          sortOrder: 1,
          durationSec: timing.demoSec,
          visualTreatment: 'USER_UPLOAD',
          sceneDescription: `Demo video: ${demoName ?? 'uploaded demo'}`.slice(0, 500),
          assetId: demo.id,
          transitionOut: 'cut',
          state: 'READY',
        },
      });
      // ONE caption, on the hook only (TikTok-classic: white, black stroke, no box).
      await tx.textOverlay.create({
        data: classicOverlayRow({
          shotId: hook.id,
          text: hookLine,
          startAtSec: 0,
          endAtSec: timing.hookSec,
          style: hookCaptionStyle(stacked),
          presetId: hookPresetId,
          lang: project.language,
        }),
      });
    }
  });
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId: data.runId,
    patch: { hookDemo: { ...doc, writtenHookLine: hookLine } },
  });
  await storeFormatCopy(
    deps,
    data,
    project,
    [hookLine, project.description ?? ''].filter(Boolean),
    log,
  );
  const queued = await startAssets(deps, data);
  log.info(
    { formats: formats.length, hookSource: source.kind, queued, ...timingFor(false) },
    'hook + demo planned',
  );
}
