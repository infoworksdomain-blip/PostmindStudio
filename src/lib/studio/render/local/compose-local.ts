import type { Prisma } from '@prisma/client';
import type { Logger } from 'pino';
import { ConflictError, NotImplementedError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import { masterStoredRender, type MasteringReport } from '../../pipeline/mastering';
import { recordRunRender } from '../../pipeline/project-state';
import type { AspectRatio } from '../../providers/interface';
import { providerOutputKey } from '../../storage';
import { LOCAL_RENDER_SOURCE_TYPES } from './config';
import { LOCAL_RENDERER_ID, type LocalRenderResult } from './renderer';

// BACKLOG 23.5 — the compose step's renderer choice (queue/workers/compose-video.ts calls this
// once, between building every variant's edit and submitting the rest to the composer).
// A SLIDESHOW or WALL_OF_TEXT variant is rendered locally when the local renderer is configured
// (STUDIO_LOCAL_RENDER, default on) and ffmpeg runs here. The local render is stored exactly where
// a Shotstack output goes (renders bucket, providerOutputKey), probed and passed through the same
// mastering check, and recorded as a video_renders row (cost 0) plus a provider_jobs row for
// provider `local-ffmpeg` (duration, 0p) — so the quality gate, review, multi-format and
// publishing paths are unchanged. A variant the local renderer does not draw (NotImplementedError)
// or whose local render fails for any other reason is returned in `remaining`, and the caller
// renders it with Shotstack as before; if Shotstack is unavailable too, the existing composition
// failure applies.

export interface LocalVariant {
  readonly script: { readonly id: string; readonly targetPlatform: string };
  readonly aspectRatio: AspectRatio;
  readonly edit: Record<string, unknown>;
  readonly composition: Record<string, unknown>;
}

export type LocalComposeDeps = Pick<
  PipelineDeps,
  'db' | 'storage' | 'media' | 'mastering' | 'logger' | 'config' | 'fetch' | 'localRenderer' | 'now'
>;

export interface LocalComposeInput<T extends LocalVariant> {
  readonly project: {
    readonly id: string;
    readonly organisationId: string;
    readonly sourceType: string;
  };
  readonly runId: string;
  readonly variants: readonly T[];
  readonly log: Logger;
  /** Filled in for every variant rendered here (scriptId → render id / mastering report). */
  readonly renders: Record<string, string>;
  readonly masteringReports: Record<string, MasteringReport>;
}

export interface LocalComposeOutcome<T> {
  /** Variants still to render with the composer (Shotstack). */
  readonly remaining: T[];
  /** The run was superseded while recording a render (the caller discards the job). */
  readonly stale: boolean;
}

type Outcome = 'rendered' | 'fallback' | 'stale';

/** Thrown inside the render transaction to roll it back when the run was superseded. */
class LocalStaleRunError extends ConflictError {
  constructor() {
    super('Run superseded');
  }
}

/** Why a project's variants are (not) rendered locally; null = local. */
export async function localRenderSkipReason(
  deps: Pick<LocalComposeDeps, 'localRenderer'>,
  sourceType: string,
): Promise<string | null> {
  if (!LOCAL_RENDER_SOURCE_TYPES.has(sourceType)) return 'source type rendered by the composer';
  if (!deps.localRenderer) return 'local renderer off';
  if (!(await deps.localRenderer.available())) return 'ffmpeg not available';
  return null;
}

export async function renderLocalVariants<T extends LocalVariant>(
  deps: LocalComposeDeps,
  input: LocalComposeInput<T>,
): Promise<LocalComposeOutcome<T>> {
  if (input.variants.length === 0) return { remaining: [], stale: false };
  const skip = await localRenderSkipReason(deps, input.project.sourceType);
  if (skip) {
    if (LOCAL_RENDER_SOURCE_TYPES.has(input.project.sourceType))
      input.log.info({ reason: skip }, 'local renderer not used; rendering with the composer');
    return { remaining: [...input.variants], stale: false };
  }
  const outcomes = await Promise.all(input.variants.map((v) => renderOne(deps, input, v)));
  return {
    remaining: input.variants.filter((_, i) => outcomes[i] === 'fallback'),
    stale: outcomes.includes('stale'),
  };
}

async function recordJob(
  deps: LocalComposeDeps,
  input: LocalComposeInput<LocalVariant>,
  variant: LocalVariant,
  outcome:
    | { state: 'SUCCEEDED'; result: LocalRenderResult }
    | { state: 'FAILED'; error: unknown; durationMs: number },
): Promise<string> {
  const started = new Date(
    deps.now() - (outcome.state === 'SUCCEEDED' ? outcome.result.renderMs : outcome.durationMs),
  );
  const row = await deps.db.providerJob.create({
    data: {
      organisationId: input.project.organisationId,
      projectId: input.project.id,
      provider: LOCAL_RENDERER_ID,
      operation: 'composition',
      requestBody: {
        scriptId: variant.script.id,
        targetPlatform: variant.script.targetPlatform,
        aspectRatio: variant.aspectRatio,
      },
      state: outcome.state,
      startedAt: started,
      completedAt: new Date(deps.now()),
      costPence: 0,
      ...(outcome.state === 'SUCCEEDED'
        ? {
            durationMs: Math.round(outcome.result.renderMs),
            responseBody: {
              bytes: outcome.result.bytes.byteLength,
              measuredLufs: outcome.result.measuredLufs,
              notes: [...outcome.result.notes],
            },
          }
        : {
            durationMs: Math.round(outcome.durationMs),
            errorClass: outcome.error instanceof Error ? outcome.error.name : 'unknown',
            errorMessage: String(
              outcome.error instanceof Error ? outcome.error.message : outcome.error,
            ).slice(0, 1_000),
          }),
    },
    select: { id: true },
  });
  return row.id;
}

async function renderOne(
  deps: LocalComposeDeps,
  input: LocalComposeInput<LocalVariant>,
  variant: LocalVariant,
): Promise<Outcome> {
  const renderer = deps.localRenderer;
  if (!renderer) return 'fallback';
  const log = input.log.child({ scriptId: variant.script.id, renderer: LOCAL_RENDERER_ID });
  const started = deps.now();
  let result: LocalRenderResult;
  try {
    result = await renderer.render(variant.edit, { fetch: deps.fetch });
  } catch (err) {
    if (err instanceof NotImplementedError) {
      log.info({ reason: err.message }, 'edit not drawn locally; rendering with the composer');
      return 'fallback';
    }
    log.warn({ err }, 'local render failed; falling back to the composer');
    await recordJob(deps, input, variant, {
      state: 'FAILED',
      error: err,
      durationMs: deps.now() - started,
    }).catch((recordErr: unknown) => log.warn({ err: recordErr }, 'local render job not recorded'));
    return 'fallback';
  }
  try {
    return await storeAndRecord(deps, input, variant, result, log);
  } catch (err) {
    if (err instanceof LocalStaleRunError) return 'stale';
    log.warn({ err }, 'local render could not be stored; falling back to the composer');
    return 'fallback';
  }
}

async function storeAndRecord(
  deps: LocalComposeDeps,
  input: LocalComposeInput<LocalVariant>,
  variant: LocalVariant,
  result: LocalRenderResult,
  log: Logger,
): Promise<Outcome> {
  const { project } = input;
  const stored = await deps.storage.put({
    bucket: deps.config.rendersBucket,
    key: providerOutputKey({
      organisationId: project.organisationId,
      projectId: project.id,
      providerId: LOCAL_RENDERER_ID,
      extension: 'mp4',
    }),
    body: result.bytes,
    contentType: 'video/mp4',
  });
  // 13.26: the same loudness / codec check as a composer render (normally already compliant).
  const mastered = await masterStoredRender(deps, {
    stored,
    probe: await deps.media.probe(stored.url),
    organisationId: project.organisationId,
    projectId: project.id,
  });
  const jobId = await recordJob(deps, input, variant, { state: 'SUCCEEDED', result });
  const probe = mastered.probe;
  const render = await deps.db.$transaction(async (tx) => {
    const created = await tx.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: variant.script.id,
        targetPlatform: variant.script.targetPlatform,
        aspectRatio: variant.aspectRatio,
        resolution: `${probe.width}x${probe.height}`,
        durationSec: probe.durationSec,
        fps: Math.round(probe.fps),
        bitrateKbps: probe.bitRateKbps,
        s3Bucket: mastered.stored.bucket,
        s3Key: mastered.stored.key,
        composerJobId: `${LOCAL_RENDERER_ID}:${jobId}`,
        qualityCheckState: 'PENDING',
        costPence: 0,
        composition: {
          ...variant.composition,
          renderer: { provider: LOCAL_RENDERER_ID, renderMs: Math.round(result.renderMs) },
        } as Prisma.InputJsonValue,
      },
    });
    const recorded = await recordRunRender(tx, {
      projectId: project.id,
      runId: input.runId,
      scriptId: variant.script.id,
      renderId: created.id,
    });
    if (!recorded) throw new LocalStaleRunError();
    return created;
  });
  input.renders[variant.script.id] = render.id;
  input.masteringReports[variant.script.id] = mastered.report;
  log.info(
    { renderId: render.id, renderMs: Math.round(result.renderMs), notes: result.notes },
    'rendered locally',
  );
  return 'rendered';
}
