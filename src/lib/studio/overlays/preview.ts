import type { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ProviderError, RateLimitError } from '../../errors';
import { buildShotstackEdit, outputDimensions } from '../pipeline/edl';
import { copyUrlToStorage } from '../pipeline/persist';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { runProvider } from '../pipeline/provider-run';
import type { AspectRatio } from '../providers/interface';
import type { PlanTier } from '../providers/router';
import { providerOutputKey, type AssetStorage } from '../storage';
import { buildOverlayTrack, mergeOverlayTrack } from './compose';

// BACKLOG 8.7 / Addendum A4.8 — POST /overlays/:id/preview: a ≤3-second, preview-resolution
// render of the overlay's shot with just that overlay, for the editor. Uses the documented
// Shotstack output `range` and `resolution: "preview"`; the result is copied into our storage
// and returned as a short-lived signed URL.

export const PREVIEW_SECONDS = 3;
const PREVIEW_URL_TTL_SEC = 60 * 60;
const LEAD_IN_SEC = 0.5;
/** Each preview is a billed composer render: cap them per project per hour. */
export const MAX_PREVIEWS_PER_PROJECT_PER_HOUR = 30;
const PREVIEWABLE_STATES = ['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW'];

export interface PreviewDeps {
  db: PrismaClient;
  storage: AssetStorage;
  bucket: string;
  providers: ProviderRunDeps;
  fetchImpl: typeof fetch;
  fontsBaseUrl: string | undefined;
}

/** Range that shows the overlay's entrance: starts just before it, clamped inside the shot. */
export function previewRange(
  shotSec: number,
  overlayStartSec: number,
): { start: number; length: number } {
  const length = Math.min(PREVIEW_SECONDS, shotSec);
  const start = Math.max(0, Math.min(overlayStartSec - LEAD_IN_SEC, shotSec - length));
  return { start: Math.round(start * 1000) / 1000, length: Math.round(length * 1000) / 1000 };
}

export async function previewOverlay(
  deps: PreviewDeps,
  scope: { organisationId: string; planTier: PlanTier },
  overlayId: string,
): Promise<{ url: string; expiresInSec: number; range: { start: number; length: number } }> {
  const overlay = await deps.db.textOverlay.findUnique({ where: { id: overlayId } });
  const shot = overlay?.shotId
    ? await deps.db.videoShot.findFirst({
        where: {
          id: overlay.shotId,
          script: { project: { organisationId: scope.organisationId, deletedAt: null } },
        },
        include: { script: { include: { project: true } } },
      })
    : null;
  if (!overlay || (!shot && !overlay.renderId)) throw new NotFoundError('Overlay not found');
  if (!shot)
    throw new ConflictError('Whole-video overlays are previewed by re-rendering the video');
  if (!PREVIEWABLE_STATES.includes(shot.script.project.state))
    throw new ConflictError(
      `Previews are not available while the project is ${shot.script.project.state}`,
    );
  const recent = await deps.db.providerJob.count({
    where: {
      organisationId: scope.organisationId,
      projectId: shot.script.projectId,
      operation: 'composition',
      startedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (recent >= MAX_PREVIEWS_PER_PROJECT_PER_HOUR)
    throw new RateLimitError('Too many preview renders for this project; try again later', 600);

  const asset = shot.assetId
    ? await deps.db.videoAsset.findFirst({
        where: { id: shot.assetId, organisationId: scope.organisationId },
      })
    : null;
  const aspectRatio = shot.script.targetAspectRatio as AspectRatio;
  const base = buildShotstackEdit({
    aspectRatio,
    shots: [
      {
        durationSec: shot.durationSec,
        visualTreatment: shot.visualTreatment,
        visualSrc: asset ? await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key) : undefined,
        visualKind: asset?.kind === 'IMAGE' ? 'image' : 'video',
        onScreenText: null,
        transitionOut: null,
        cardText: shot.onScreenText ?? shot.voiceoverText,
      },
    ],
  });
  const track = await buildOverlayTrack([{ row: overlay, offsetSec: 0 }], {
    frame: outputDimensions(aspectRatio),
    organisationId: scope.organisationId,
    language: shot.script.language,
    preRender: {
      storage: deps.storage,
      bucket: deps.bucket,
      fetchImpl: deps.fetchImpl,
      fontsBaseUrl: deps.fontsBaseUrl,
    },
  });
  const range = previewRange(shot.durationSec, overlay.startAtSec);
  const merged = mergeOverlayTrack(base, track);
  const edit = {
    ...merged,
    output: { ...(merged.output as object), resolution: 'preview', range },
  };
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'composition' },
      planTier: scope.planTier,
      request: {
        capability: 'composition',
        organisationId: scope.organisationId,
        projectId: shot.script.projectId,
        edit,
        outputDurationSec: range.length,
      },
    },
    deps.providers,
  );
  if (!run.output.url) {
    throw new ProviderError(
      run.decision.providerId,
      'unknown',
      'Composer returned no preview URL',
      true,
    );
  }
  const stored = await copyUrlToStorage(
    deps.storage,
    {
      url: run.output.url,
      bucket: deps.bucket,
      key: providerOutputKey({
        organisationId: scope.organisationId,
        projectId: shot.script.projectId,
        providerId: `${run.decision.providerId}-preview`,
        extension: 'mp4',
      }),
      fallbackContentType: 'video/mp4',
      providerId: run.decision.providerId,
    },
    deps.fetchImpl,
  );
  return {
    url: await deps.storage.signedUrl(stored.bucket, stored.key, PREVIEW_URL_TTL_SEC),
    expiresInSec: PREVIEW_URL_TTL_SEC,
    range,
  };
}
