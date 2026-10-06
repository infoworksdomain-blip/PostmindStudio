import type { VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import type { PipelineDeps } from '../../pipeline/deps';
import { failProject, mergeProjectMetadata } from '../../pipeline/project-state';
import { parseTargetFormats } from '../../pipeline/scripting';
import { classicOverlayRow, wallTextStyle } from '../../formats/caption-style';
import {
  buildWallTextPrompt,
  parseWallText,
  WALL_TEXT_OUTPUT_SCHEMA,
  WALL_TEXT_SYSTEM_PROMPT,
} from '../../formats/copy-prompt';
import { findFootageClip } from '../../formats/footage';
import { wordCount } from '../../formats/hook-demo';
import {
  readWallOfText,
  WALL_BACKGROUND_QUERIES,
  WALL_LIBRARY_CATEGORIES,
} from '../../formats/wall-of-text';
import type { ProjectJobData } from '../queues';
import {
  formatCopyContext,
  passesTextSafety,
  startAssets,
  storeFormatCopy,
  writeCopy,
} from './format-plan-common';

// BACKLOG 22.2 — the "plan" step of a WALL_OF_TEXT run (formats/wall-of-text.ts): the text block
// is the owner's or one Claude call (≤ 60 words, line breaks, no emoji); it passes the same
// text-safety gate as every video; then each target format gets ONE shot for the whole video
// (6–12 s): a FOOTAGE-licensed library background, or stock footage through the STOCK_FOOTAGE
// route (generate-asset.ts) searched with the background mood. The block is ONE overlay for the
// whole shot. The music bed (compose-video.ts, Layer 5) is the only audio; the footage is muted.

export async function planWallOfText(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  log: Logger,
): Promise<void> {
  const doc = readWallOfText(project.metadata);
  if (!doc) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: 'wall_of_text_invalid: the text settings are missing',
    });
    return log.warn('wall-of-text settings missing; project failed');
  }
  const text =
    doc.text ??
    parseWallText(
      await writeCopy(deps, data, {
        system: WALL_TEXT_SYSTEM_PROMPT,
        prompt: buildWallTextPrompt(await formatCopyContext(deps, project, log)),
        schema: WALL_TEXT_OUTPUT_SCHEMA,
      }),
    );
  if (!(await passesTextSafety(deps, data, project, text.split('\n'), log))) return;

  const formats = parseTargetFormats(project.targetFormats);
  const clip = await findFootageClip(deps.db, {
    categories: WALL_LIBRARY_CATEGORIES[doc.background],
    minSec: doc.durationSec,
    aspectRatio: formats[0]?.aspectRatio ?? '9:16',
    seed: project.id,
    now: new Date(deps.now()),
  });
  await deps.db.$transaction(async (tx) => {
    await tx.textOverlay.deleteMany({ where: { shot: { script: { projectId: project.id } } } });
    await tx.videoShot.deleteMany({ where: { script: { projectId: project.id } } });
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    const libraryAsset = clip
      ? await tx.videoAsset.create({
          data: {
            organisationId: project.organisationId,
            projectId: project.id,
            kind: 'VIDEO_CLIP',
            source: `library:${clip.libraryItemId}`,
            s3Bucket: clip.s3Bucket,
            s3Key: clip.s3Key,
            durationSec: clip.durationSec,
            metadata: { libraryItemId: clip.libraryItemId, licenceMode: 'FOOTAGE' },
          },
        })
      : null;
    for (const format of formats) {
      const script = await tx.videoScript.create({
        data: {
          projectId: project.id,
          targetPlatform: format.platform,
          targetAspectRatio: format.aspectRatio,
          targetDurationSec: doc.durationSec,
          language: project.language,
          fullText: text,
          scriptModel: 'wall_of_text',
        },
      });
      const shot = await tx.videoShot.create({
        data: {
          scriptId: script.id,
          sortOrder: 0,
          durationSec: doc.durationSec,
          visualTreatment: 'STOCK_FOOTAGE',
          // The stock search text (generate-asset.ts STOCK_FOOTAGE: the scene is the query).
          sceneDescription: WALL_BACKGROUND_QUERIES[doc.background],
          onScreenText: text.slice(0, 2_000),
          transitionOut: 'cut',
          ...(libraryAsset
            ? {
                assetId: libraryAsset.id,
                state: 'READY' as const,
                providerRouting: { visual: { providerId: 'video-library' } },
              }
            : { state: 'QUEUED' as const }),
        },
      });
      // ONE text block for the whole video (TikTok-classic, no box).
      await tx.textOverlay.create({
        data: classicOverlayRow({
          shotId: shot.id,
          text,
          startAtSec: 0,
          endAtSec: doc.durationSec,
          style: wallTextStyle(wordCount(text)),
          lang: project.language,
        }),
      });
    }
  });
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId: data.runId,
    patch: { wallOfText: { ...doc, writtenText: text } },
  });
  await storeFormatCopy(deps, data, project, text.split('\n'), log);
  const queued = await startAssets(deps, data);
  log.info(
    { formats: formats.length, background: clip ? 'library' : 'stock', queued },
    'wall of text planned',
  );
}
