import type { Prisma, PrismaClient, VideoRender } from '@prisma/client';
import type { Logger } from 'pino';
import { NotFoundError } from '../../errors';
import { mergeMetadata } from '../automation/approval';
import { projectMetadata } from '../pipeline/project-state';
import { spokenWordsOf } from '../pipeline/word-timing';
import type { AssetStorage } from '../storage';
import { captionLines, type CaptionLine } from './captions';
import { applyBrand, resolveStyle, type OverlayStyle } from './params';
import { BUILT_IN_PRESETS } from './presets';

// 15.A4 — narration captions per format (spec 3.1 "Captions: auto-generated in any supported
// voice language; user-editable"; 5.8 "YouTube gets uploaded as SRT alongside the video").
// Lines come from the 13.6 word timings of each shot's voiceover (AssemblyAI words, stored on the
// voice asset) grouped by captionLines (overlays/captions.ts, shared with 13.5 uploads).
//   - Reels, Shorts, Facebook, Instagram/Facebook feed, LinkedIn, X: burned in as editable
//     text_overlays rows on the shots (subtitle_box preset, lifted above the platform UI);
//   - TikTok: burned in with a TikTok-native look (the hook_tiktok_native preset's styling);
//   - YouTube long-form: not burned in; an SRT is written next to the render and uploaded with
//     captions.insert when publishing (platforms/youtube.ts).
// DECISION (Phase 15): LinkedIn and X are muted-autoplay feeds, so they are burned in too.
// Rows are created once per voice take: project.metadata.voiceCaptions[shotId] records the voice
// asset they were made from and the overlay ids, so edits and deletions stick; a re-voiced shot
// (13.1) gets fresh captions (its old caption rows are replaced).

export type CaptionMode = 'burn' | 'srt';

export function captionModeFor(platform: string): CaptionMode {
  return platform === 'youtube' ? 'srt' : 'burn';
}

/**
 * Caption lines for narration that stay within the §13.1 caption_sync tolerance (±200 ms): the
 * shared grouping (overlays/captions.ts) keeps a line on screen ≥ 0.6 s, which can outlast the
 * last spoken word; narration captions end with their last word instead (+ a small hold).
 */
const END_HOLD_SEC = 0.1;

export function narrationLines(
  words: Array<{ text: string; startSec: number; endSec: number }>,
  maxEndSec: number,
): CaptionLine[] {
  return captionLines(words, maxEndSec).map((line) => {
    const spoken = words.filter(
      (w) => w.startSec >= line.startAtSec - 0.001 && w.startSec < line.endAtSec,
    );
    const lastEnd = Math.max(...spoken.map((w) => w.endSec), line.startAtSec + 0.1);
    const end = Math.min(line.endAtSec, Math.round((lastEnd + END_HOLD_SEC) * 1000) / 1000);
    return { ...line, endAtSec: Math.min(maxEndSec, end) };
  });
}

/** Where burned-in narration sits: above the lower UI band (like/comment rails, captions). */
const CAPTION_ANCHOR_Y = 0.7;
const TIKTOK_FONT_PCT = 4;

export function captionStyle(
  platform: string,
  brand: { primary?: string; secondary?: string; fontFamily?: string } | null,
): { style: OverlayStyle; presetName: string } | null {
  const key = platform === 'tiktok' ? 'hook_tiktok_native' : 'subtitle_box';
  const preset = BUILT_IN_PRESETS.find((p) => p.key === key);
  if (!preset) return null;
  const base = resolveStyle(preset.parameters, {
    anchorY: CAPTION_ANCHOR_Y,
    ...(platform === 'tiktok' && { fontSizePct: TIKTOK_FONT_PCT }),
  });
  return {
    style: preset.brandSubstitution ? applyBrand(base, brand) : base,
    presetName: preset.name,
  };
}

export interface CaptionShot {
  id: string;
  sortOrder: number;
  durationSec: number;
  words: Array<{ text: string; startSec: number; endSec: number }>;
}

/** Caption lines on the whole-video timeline (each shot's lines offset by its start). */
export function timelineLines(shots: CaptionShot[]): CaptionLine[] {
  let offset = 0;
  const out: CaptionLine[] = [];
  for (const shot of [...shots].sort((a, b) => a.sortOrder - b.sortOrder)) {
    for (const line of narrationLines(shot.words, shot.durationSec))
      out.push({
        text: line.text,
        startAtSec: Math.round((line.startAtSec + offset) * 1000) / 1000,
        endAtSec: Math.round((line.endAtSec + offset) * 1000) / 1000,
      });
    offset += shot.durationSec;
  }
  return out;
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** SubRip text (numbered cues, HH:MM:SS,mmm --> HH:MM:SS,mmm, blank line between cues). */
export function toSrt(lines: CaptionLine[]): string {
  return lines
    .map((l, i) => `${i + 1}\n${srtTime(l.startAtSec)} --> ${srtTime(l.endAtSec)}\n${l.text}\n`)
    .join('\n');
}

type Db = Pick<
  PrismaClient,
  | 'videoProject'
  | 'videoAsset'
  | 'videoShot'
  | 'textOverlay'
  | 'overlayPreset'
  | 'brandKit'
  | '$executeRaw'
>;

interface VoiceCaptionRecord {
  voiceAssetId: string;
  overlayIds: string[];
}

async function loadShots(db: Db, scriptId: string, organisationId: string) {
  const shots = await db.videoShot.findMany({
    where: { scriptId },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      sortOrder: true,
      durationSec: true,
      voiceAssetId: true,
      visualTreatment: true,
    },
  });
  const ids = shots.flatMap((s) => (s.voiceAssetId ? [s.voiceAssetId] : []));
  const assets = ids.length
    ? await db.videoAsset.findMany({
        where: { id: { in: ids }, organisationId },
        select: { id: true, metadata: true },
      })
    : [];
  const words = new Map(assets.map((a) => [a.id, spokenWordsOf(a.metadata)]));
  return shots.map((s) => ({
    ...s,
    words: s.voiceAssetId ? (words.get(s.voiceAssetId) ?? []) : [],
  }));
}

/**
 * Before composition: burned-in narration captions for every script whose platform burns them
 * in. Never throws (captions must not fail a render); returns how many rows were written.
 */
export async function ensureVoiceCaptions(
  deps: { db: Db; logger: Logger },
  input: { projectId: string; organisationId: string },
): Promise<number> {
  try {
    const project = await deps.db.videoProject.findFirst({
      where: { id: input.projectId, organisationId: input.organisationId },
      select: {
        id: true,
        sourceType: true,
        language: true,
        brandKitId: true,
        metadata: true,
        scripts: { select: { id: true, targetPlatform: true } },
      },
    });
    if (!project || project.sourceType === 'SLIDESHOW') return 0;
    const records = {
      ...((projectMetadata(project.metadata).voiceCaptions as Record<string, VoiceCaptionRecord>) ??
        {}),
    };
    const kit = project.brandKitId
      ? await deps.db.brandKit.findFirst({
          where: { id: project.brandKitId, organisationId: input.organisationId },
          select: { colourPalette: true, fontPrimary: true },
        })
      : null;
    const palette = Array.isArray(kit?.colourPalette)
      ? (kit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    const brand = kit
      ? { primary: palette[0], secondary: palette[1], fontFamily: kit.fontPrimary ?? undefined }
      : null;
    const presets = await deps.db.overlayPreset.findMany({
      where: { scope: 'BUILT_IN', name: { in: ['Box Background', 'TikTok Native'] } },
      select: { id: true, name: true },
    });
    const presetId = new Map(presets.map((p) => [p.name, p.id]));
    let written = 0;
    let changed = false;
    for (const script of project.scripts) {
      if (captionModeFor(script.targetPlatform) !== 'burn') continue;
      const chosen = captionStyle(script.targetPlatform, brand);
      if (!chosen) continue;
      for (const shot of await loadShots(deps.db, script.id, input.organisationId)) {
        if (!shot.voiceAssetId || shot.visualTreatment === 'USER_UPLOAD') continue;
        const previous = records[shot.id];
        if (previous?.voiceAssetId === shot.voiceAssetId) continue;
        const lines = narrationLines(shot.words, shot.durationSec);
        if (previous?.overlayIds.length)
          await deps.db.textOverlay.deleteMany({
            where: { id: { in: previous.overlayIds }, shotId: shot.id },
          });
        const created: string[] = [];
        for (const [i, line] of lines.entries()) {
          const row = await deps.db.textOverlay.create({
            data: {
              shotId: shot.id,
              presetId: presetId.get(chosen.presetName) ?? null,
              text: line.text,
              lang: project.language,
              startAtSec: line.startAtSec,
              endAtSec: line.endAtSec,
              sortOrder: Math.min(50 + i, 100),
              ...chosen.style,
              effect: (chosen.style.effect ?? undefined) as Prisma.InputJsonValue | undefined,
            },
            select: { id: true },
          });
          created.push(row.id);
        }
        records[shot.id] = { voiceAssetId: shot.voiceAssetId, overlayIds: created };
        written += created.length;
        changed = true;
      }
    }
    if (changed) await mergeMetadata(deps.db, project.id, { voiceCaptions: records });
    return written;
  } catch (err) {
    deps.logger.warn(
      { err, projectId: input.projectId },
      'voice captions could not be created; rendering without them',
    );
    return 0;
  }
}

export interface RenderCaptions {
  mode: CaptionMode;
  language: string;
  lines: CaptionLine[];
  srt: string;
}

/** The narration captions of a render (its script's voice timings on the video timeline). */
export async function renderCaptions(
  db: Db,
  render: Pick<VideoRender, 'scriptId' | 'targetPlatform' | 'projectId'>,
  organisationId: string,
): Promise<RenderCaptions> {
  const project = await db.videoProject.findFirst({
    where: { id: render.projectId, organisationId },
    select: { language: true },
  });
  if (!project) throw new NotFoundError('Project not found');
  const shots = await loadShots(db, render.scriptId, organisationId);
  const lines = timelineLines(shots);
  return {
    mode: captionModeFor(render.targetPlatform),
    language: project.language,
    lines,
    srt: toSrt(lines),
  };
}

/**
 * The render's SRT in storage (written next to the render the first time it is needed and
 * recorded in video_renders.captionsSrtS3Key). null when the narration has no word timings.
 */
export async function ensureRenderSrt(
  deps: { db: Db & Pick<PrismaClient, 'videoRender'>; storage: AssetStorage },
  render: VideoRender,
  organisationId: string,
): Promise<{ key: string; captions: RenderCaptions } | null> {
  const captions = await renderCaptions(deps.db, render, organisationId);
  if (captions.lines.length === 0) return null;
  if (render.captionsSrtS3Key) return { key: render.captionsSrtS3Key, captions };
  const key = `${render.s3Key.replace(/\.[a-z0-9]+$/i, '')}.srt`;
  await deps.storage.put({
    bucket: render.s3Bucket,
    key,
    body: new TextEncoder().encode(captions.srt),
    contentType: 'application/x-subrip',
  });
  await deps.db.videoRender.update({ where: { id: render.id }, data: { captionsSrtS3Key: key } });
  return { key, captions };
}
