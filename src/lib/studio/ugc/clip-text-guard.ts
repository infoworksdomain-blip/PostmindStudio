import type { Prisma } from '@prisma/client';
import { ValidationError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import { jsonOutput, runProvider } from '../pipeline/provider-run';
import type { QualityCheck } from '../pipeline/quality-checks';
import type { PlanTier } from '../providers/router';

// BACKLOG 21.4c (production 2026-10-06, UGC QA video 3, project cmuvx27w60000mo07w33r2xyu): the
// third Veo 3.1 Fast actor clip came back with its OWN burned-in subtitles (misspelt, white, no
// stroke) under the creator, on top of our TikTok-classic captions: two caption blocks in one
// frame. The prompt fix (providers/dialogue.ts) makes this rarer; this guard catches the rest.
//
// After an actor clip is stored, 3 small frames go to Claude (vision) through the router in ONE
// text_generation call (the library ingest's call shape, library/ingest.ts analyseContent), with
// a strict yes/no question per frame. Any "yes" → the clip is regenerated ONCE with the same
// prompt and references (generate-asset.ts generateActor, through runProvider: budgets, caps, kill
// switch and cost tracking as for the first clip). If the retry has text too it is kept and the
// quality gate shows a `warning` (clip_text, quality-brand-gate.ts), so a person reviews it and it
// is never auto-approved. The check is skippable (STUDIO_CLIP_TEXT_GUARD=false or
// config.clipTextGuard) and resilient: any frame-grab, routing or vision failure is logged and the
// clip is kept as if clean — it never fails the shot or the project.

export const CLIP_TEXT_GUARD_ENV = 'STUDIO_CLIP_TEXT_GUARD';

/** Where in the clip the frames are taken (fractions of its length): the line, then its end. */
export const CLIP_TEXT_FRAME_POSITIONS = [0.25, 0.55, 0.85] as const;
/** Small frames: burned-in subtitles are large; ~512 px keeps the vision input cheap. */
export const CLIP_TEXT_FRAME_WIDTH = 512;
const CLIP_TEXT_MAX_TOKENS = 300;

/** The question asked of every frame (21.4c, operator wording). */
export const CLIP_TEXT_QUESTION =
  'Does this frame contain overlaid written text such as subtitles, captions, titles or watermarks (ignore text that is physically part of the scene, e.g. a book cover or phone screen)?';

export const CLIP_TEXT_SYSTEM =
  'You inspect frames of a generated video clip for text that was burned in on top of the picture. Answer strictly; reply only with the JSON requested.';

export const CLIP_TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frames'],
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'answer'],
        properties: {
          frame: { type: 'integer', description: '1-based frame number, in the order given' },
          answer: { type: 'string', enum: ['yes', 'no'] },
        },
      },
    },
  },
} as const;

/** Unset / "true" = on (the default); "false" = off. Anything else is ignored (stays on). */
export function clipTextGuardEnabled(
  config: { clipTextGuard?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (config.clipTextGuard !== undefined) return config.clipTextGuard;
  return env[CLIP_TEXT_GUARD_ENV]?.trim().toLowerCase() !== 'false';
}

export function clipTextFrameTimes(durationSec: number): number[] {
  const length = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 8;
  return CLIP_TEXT_FRAME_POSITIONS.map((p) => Math.round(length * p * 1000) / 1000);
}

export function clipTextPrompt(frameCount: number): string {
  return [
    `You are given ${frameCount} frame(s) of one generated video clip, numbered 1 to ${frameCount} in the order shown.`,
    `For EACH frame answer "yes" or "no": ${CLIP_TEXT_QUESTION}`,
    'Answer "no" when the only text is printed on an object in the scene (a label, a sign, a screen).',
    'Return {"frames":[{"frame":1,"answer":"yes"|"no"}, …]} with one entry per frame.',
  ].join('\n');
}

/**
 * The 1-based frames that have overlaid text. Strict: exactly one "yes"/"no" per frame, numbered
 * 1…frameCount, or a ValidationError (the guard then skips rather than guessing).
 */
export function parseClipTextAnswer(json: unknown, frameCount: number): number[] {
  const frames = (json as { frames?: unknown } | null)?.frames;
  if (!Array.isArray(frames) || frames.length !== frameCount)
    throw new ValidationError(`Expected ${frameCount} frame answers`);
  const seen = new Set<number>();
  const withText: number[] = [];
  for (const entry of frames as unknown[]) {
    const { frame, answer } = (entry ?? {}) as { frame?: unknown; answer?: unknown };
    if (
      typeof frame !== 'number' ||
      !Number.isInteger(frame) ||
      frame < 1 ||
      frame > frameCount ||
      seen.has(frame)
    )
      throw new ValidationError('Frame answers must number each frame once');
    if (answer !== 'yes' && answer !== 'no')
      throw new ValidationError('Frame answers must be "yes" or "no"');
    seen.add(frame);
    if (answer === 'yes') withText.push(frame);
  }
  return withText.sort((a, b) => a - b);
}

export type ClipTextResult =
  | { status: 'text' | 'clean'; frames: number; framesWithText: number[]; costPence: number }
  | { status: 'skipped'; reason: string };

export interface ClipTextTarget {
  organisationId: string;
  projectId: string;
  shotId: string;
  planTier: PlanTier;
  durationSec: number;
  assetId: string;
}

/** Frames of the stored clip → one vision call → text / clean, or skipped on any failure. */
export async function detectBurnedInText(
  deps: PipelineDeps,
  target: ClipTextTarget,
): Promise<ClipTextResult> {
  try {
    const asset = await deps.db.videoAsset.findUnique({
      where: { id: target.assetId },
      select: { s3Bucket: true, s3Key: true },
    });
    if (!asset) return { status: 'skipped', reason: 'asset not found' };
    const url = await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key);
    const images: Array<{ mediaType: 'image/jpeg'; data: string }> = [];
    // Sequential: the ffmpeg concurrency limiter (process-limit.ts) is shared with renders.
    for (const at of clipTextFrameTimes(target.durationSec)) {
      const bytes = await deps.media.frameJpeg(url, at, CLIP_TEXT_FRAME_WIDTH);
      images.push({ mediaType: 'image/jpeg', data: Buffer.from(bytes).toString('base64') });
    }
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'text_generation' },
        planTier: target.planTier,
        request: {
          capability: 'text_generation',
          organisationId: target.organisationId,
          projectId: target.projectId,
          shotId: target.shotId,
          system: CLIP_TEXT_SYSTEM,
          prompt: clipTextPrompt(images.length),
          images,
          maxTokens: CLIP_TEXT_MAX_TOKENS,
          outputSchema: CLIP_TEXT_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      deps,
    );
    const framesWithText = parseClipTextAnswer(jsonOutput(run.output), images.length);
    const job = await deps.db.providerJob.findUnique({
      where: { id: run.providerJobRowId },
      select: { costPence: true },
    });
    return {
      status: framesWithText.length > 0 ? 'text' : 'clean',
      frames: images.length,
      framesWithText,
      costPence: job?.costPence ?? 0,
    };
  } catch (err) {
    const reason = (err as Error).message?.slice(0, 300) || 'unknown error';
    deps.logger.warn(
      { projectId: target.projectId, shotId: target.shotId, assetId: target.assetId, reason },
      'burned-in text check failed; clip kept unchecked',
    );
    return { status: 'skipped', reason };
  }
}

/** metadata.clipText on an actor clip (read by the quality gate, quality-brand-gate.ts). */
export interface ClipTextRecord {
  attempt: 1 | 2;
  status: ClipTextResult['status'];
  framesWithText?: number[];
  costPence?: number;
  reason?: string;
}

export function clipTextOf(metadata: Prisma.JsonValue | null | undefined): ClipTextRecord | null {
  const record = (metadata as { clipText?: unknown } | null)?.clipText;
  if (!record || typeof record !== 'object') return null;
  const status = (record as { status?: unknown }).status;
  return status === 'text' || status === 'clean' || status === 'skipped'
    ? (record as ClipTextRecord)
    : null;
}

/**
 * The quality gate's clip_text check: a `warning` (does not fail the gate, keeps the video from
 * auto-approval, automation/review-policy.ts) naming the shots whose kept actor clip still has
 * burned-in text. Null when no shot has any (the check is then not listed at all).
 */
export function evaluateClipText(
  shots: ReadonlyArray<{ number: number; clipText: ClipTextRecord | null }>,
): QualityCheck | null {
  const flagged = shots.filter((s) => s.clipText?.status === 'text').map((s) => s.number);
  if (flagged.length === 0) return null;
  return {
    code: 'clip_text',
    status: 'warning',
    severity: 'info',
    detail: `review needed — burned-in text (subtitles or captions) in the generated clip of shot(s) ${flagged.join(', ')}`,
    detailKey: 'clipTextBurnedIn',
    detailParams: { count: flagged.length, shots: flagged.join(', ') },
  };
}

/** The reason recorded on a clip regenerated because of burned-in text. */
export const REGENERATED_FOR_TEXT = 'burned_in_text';

async function recordCheck(
  deps: PipelineDeps,
  assetId: string,
  attempt: 1 | 2,
  result: ClipTextResult,
): Promise<void> {
  const current = await deps.db.videoAsset.findUnique({
    where: { id: assetId },
    select: { metadata: true },
  });
  const clipText: ClipTextRecord =
    result.status === 'skipped'
      ? { attempt, status: 'skipped', reason: result.reason }
      : {
          attempt,
          status: result.status,
          framesWithText: result.framesWithText,
          costPence: result.costPence,
        };
  await deps.db.videoAsset.update({
    where: { id: assetId },
    data: {
      metadata: {
        ...((current?.metadata as Record<string, unknown> | null) ?? {}),
        clipText,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Checks a stored actor clip; with burned-in text, regenerates it once (`regenerate` makes and
 * records the new clip with the same prompt and references, and returns its asset id) and checks
 * the new one. Returns the asset the shot keeps. Never more than one regeneration.
 */
export async function guardActorClip(
  deps: PipelineDeps,
  target: ClipTextTarget,
  regenerate: (reason: typeof REGENERATED_FOR_TEXT) => Promise<string>,
): Promise<string> {
  if (!clipTextGuardEnabled(deps.config)) return target.assetId;
  const first = await detectBurnedInText(deps, target);
  await recordCheck(deps, target.assetId, 1, first);
  if (first.status !== 'text') return target.assetId;
  const log = { projectId: target.projectId, shotId: target.shotId, assetId: target.assetId };
  deps.logger.warn(
    { ...log, framesWithText: first.framesWithText },
    'actor clip has burned-in text; regenerating once',
  );
  let retryAssetId: string;
  try {
    retryAssetId = await regenerate(REGENERATED_FOR_TEXT);
  } catch (err) {
    // The first clip stays (its clipText "text" makes the gate warn); the shot does not fail.
    deps.logger.warn(
      { ...log, reason: (err as Error).message },
      'regenerating the actor clip failed; keeping the clip with text for review',
    );
    return target.assetId;
  }
  const second = await detectBurnedInText(deps, { ...target, assetId: retryAssetId });
  await recordCheck(deps, retryAssetId, 2, second);
  if (second.status === 'text')
    deps.logger.warn(
      { ...log, retryAssetId, framesWithText: second.framesWithText },
      'regenerated actor clip still has burned-in text; kept for review',
    );
  return retryAssetId;
}
