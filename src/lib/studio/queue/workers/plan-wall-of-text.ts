import type { VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import type { PipelineDeps } from '../../pipeline/deps';
import { failProject, mergeProjectMetadata } from '../../pipeline/project-state';
import { parseTargetFormats } from '../../pipeline/scripting';
import {
  builtInPresetId,
  classicOverlayRow,
  WALL_TEXT_PRESET,
  wallTextStyle,
} from '../../formats/caption-style';
import {
  buildWallTextPrompt,
  parseWallText,
  WALL_TEXT_OUTPUT_SCHEMA,
  WALL_TEXT_SYSTEM_PROMPT,
} from '../../formats/copy-prompt';
import { findFootageClip } from '../../formats/footage';
import { wordCount } from '../../formats/hook-demo';
import {
  NO_BACKGROUND_VIDEO,
  readWallOfText,
  WALL_BACKGROUND_QUERIES,
  WALL_STOCK_PROVIDER,
  WALL_LIBRARY_CATEGORIES,
  wallShownSec,
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
// is the owner's (≤ 60 words) or one Claude call (≤ 35 words on ≤ 6 lines, 22.6; no emoji), on
// screen for as long as it takes to read (wallShownSec, 22.6); it passes the same
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
  // 22.6: on screen long enough to read the block (≤ 12 s), never shorter than the choice.
  const shownSec = wallShownSec(doc.durationSec, text);

  const formats = parseTargetFormats(project.targetFormats);
  const clip = await findFootageClip(deps.db, {
    categories: WALL_LIBRARY_CATEGORIES[doc.background],
    minSec: shownSec,
    aspectRatio: formats[0]?.aspectRatio ?? '9:16',
    seed: project.id,
    now: new Date(deps.now()),
  });
  // No licensed library clip and no stock video source at all: say so before anything is made.
  if (!clip && deps.registry.getAdaptersByCapability('stock_footage').length === 0) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: NO_BACKGROUND_VIDEO,
    });
    return log.warn('no background video source; project failed');
  }
  await deps.db.$transaction(async (tx) => {
    await tx.textOverlay.deleteMany({ where: { shot: { script: { projectId: project.id } } } });
    await tx.videoShot.deleteMany({ where: { script: { projectId: project.id } } });
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    const wallPresetId = await builtInPresetId(tx, WALL_TEXT_PRESET);
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
          targetDurationSec: shownSec,
          language: project.language,
          fullText: text,
          scriptModel: 'wall_of_text',
        },
      });
      const shot = await tx.videoShot.create({
        data: {
          scriptId: script.id,
          sortOrder: 0,
          durationSec: shownSec,
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
            : {
                state: 'QUEUED' as const,
                // Pixabay first (the stock source production has), then the router's order.
                providerRouting: { preferredProviderId: WALL_STOCK_PROVIDER },
              }),
        },
      });
      // ONE text block for the whole video (TikTok-classic, no box).
      await tx.textOverlay.create({
        data: classicOverlayRow({
          shotId: shot.id,
          text,
          startAtSec: 0,
          endAtSec: shownSec,
          style: wallTextStyle(wordCount(text)),
          presetId: wallPresetId,
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
