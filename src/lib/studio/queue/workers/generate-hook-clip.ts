import type { Prisma, VideoShot } from '@prisma/client';
import { RateDeferredError, ValidationError } from '../../../errors';
import { avatarUnavailableReason } from '../../pipeline/avatar-fallback';
import type { PipelineDeps } from '../../pipeline/deps';
import { runProvider, type ProviderRunResult } from '../../pipeline/provider-run';
import { reuseAssetForShot } from '../../pipeline/asset-reuse';
import type { ActorVideoRequest, AspectRatio } from '../../providers/interface';
import type { ProviderRegistry } from '../../providers/registry';
import type { RoutableAdapter } from '../../providers/router';
import { actorImageOf } from '../../ugc/portrait';
import { findFootageClip, HOOK_LIBRARY_CATEGORIES } from '../../formats/footage';
import {
  HOOK_CLIP_DEFER_ID,
  HOOK_CLIP_KEY,
  HOOK_CLIP_WAIT_MS,
  hookClipPrompt,
  type HookClipMarker,
} from '../../formats/hook-clip';
import { HOOK_CLIP_SEC } from '../../formats/hook-demo';
import type { GenerateAssetJobData } from '../queues';

// BACKLOG 22.1 — Layer 3 for the hook shot of a hook + demo video (formats/hook-clip.ts). The
// leader hook shot of an aspect ratio makes one silent reaction clip through the actor route
// (actor_video, Veo first); followers reuse it (pipeline/asset-reuse.ts, no second payment) and
// wait for it without spending an attempt. With no actor provider available (nothing configured,
// account problem, provider kill switch — avatar-fallback.ts avatarUnavailableReason) the shot
// takes a FOOTAGE-licensed reaction clip from the reference library (formats/footage.ts); with
// none, it fails with a clear reason. A content refusal, cost-cap pause or wider kill switch fails
// the shot as for any generation.

export const HOOK_CLIP_UNAVAILABLE =
  'hook_clip_unavailable: no AI creator provider is available and the library has no reaction clip licensed as footage';

export interface HookShot extends VideoShot {
  script: {
    projectId: string;
    targetAspectRatio: string;
    project: { organisationId: string; metadata: Prisma.JsonValue };
  };
}

interface Stored {
  assetId: string;
  routing: Record<string, unknown>;
}

/** The silent reaction request (without the per-project ids) that a hook clip sends. */
function silentHookRequest(aspectRatio: AspectRatio, prompt: string): ActorVideoRequest {
  return {
    organisationId: '',
    capability: 'actor_video',
    prompt,
    spokenLine: '',
    silent: true,
    // No speech: the language only matters to adapters that speak a line.
    languageCode: 'en',
    durationSec: HOOK_CLIP_SEC,
    aspectRatio,
  };
}

/**
 * True when a registered actor_video adapter can make a SILENT clip (Veo; Kling's actor path is
 * dialogue-only and refuses it), so plans do not count a Kling-only setup as an AI creator.
 */
export function canMakeSilentHook(registry: ProviderRegistry): boolean {
  const probe = silentHookRequest('9:16', 'probe');
  return registry
    .getAdaptersByCapability('actor_video')
    .some((a) => (a as RoutableAdapter).supportsRequest?.(probe) ?? true);
}

/** The project's ready actor portrait (21.4a), when one exists: the same person in the hook. */
async function portraitUrl(deps: PipelineDeps, shot: HookShot): Promise<string | undefined> {
  const state = actorImageOf(shot.script.project.metadata).state;
  if (state?.state !== 'ready') return undefined;
  const asset = await deps.db.videoAsset.findFirst({
    where: {
      id: state.assetId,
      organisationId: shot.script.project.organisationId,
      kind: 'IMAGE',
    },
    select: { s3Bucket: true, s3Key: true },
  });
  return asset ? deps.storage.signedUrl(asset.s3Bucket, asset.s3Key) : undefined;
}

/** A follower reuses its leader's clip, or waits for it (no attempt used). */
async function followLeader(
  deps: PipelineDeps,
  shot: HookShot,
  leaderShotId: string,
): Promise<Stored> {
  const leader = await deps.db.videoShot.findFirst({
    where: { id: leaderShotId, script: { projectId: shot.script.projectId } },
    select: { assetId: true, state: true, errorReason: true },
  });
  const source = leader?.assetId
    ? await deps.db.videoAsset.findFirst({
        where: { id: leader.assetId, organisationId: shot.script.project.organisationId },
      })
    : null;
  if (source) {
    const asset = await reuseAssetForShot(deps, {
      source,
      shotId: shot.id,
      projectId: shot.script.projectId,
      capability: 'actor_video',
      pointer: 'assetId',
      routingKey: 'visual',
    });
    return { assetId: asset.id, routing: { reused: true, reusedFromShotId: leaderShotId } };
  }
  if (!leader || leader.state === 'FAILED' || leader.state === 'SKIPPED')
    throw new ValidationError(
      `The hook clip could not be made: ${leader?.errorReason ?? 'unknown'}`,
    );
  throw new RateDeferredError(HOOK_CLIP_DEFER_ID, HOOK_CLIP_WAIT_MS, {
    reason: 'hook_clip_generating',
    projectId: shot.script.projectId,
    shotId: shot.id,
  });
}

/** No actor provider: a FOOTAGE-licensed reaction clip from the library, else a clear failure. */
export async function libraryHookClip(
  deps: PipelineDeps,
  shot: HookShot,
  reason: string,
): Promise<Stored> {
  const clip = await findFootageClip(deps.db, {
    categories: HOOK_LIBRARY_CATEGORIES,
    minSec: shot.durationSec,
    aspectRatio: shot.script.targetAspectRatio,
    seed: shot.script.projectId,
    now: new Date(deps.now()),
  });
  if (!clip) throw new ValidationError(HOOK_CLIP_UNAVAILABLE, { reason });
  const asset = await deps.db.$transaction(async (tx) => {
    const created = await tx.videoAsset.create({
      data: {
        organisationId: shot.script.project.organisationId,
        projectId: shot.script.projectId,
        shotId: shot.id,
        kind: 'VIDEO_CLIP',
        source: `library:${clip.libraryItemId}`,
        s3Bucket: clip.s3Bucket,
        s3Key: clip.s3Key,
        durationSec: clip.durationSec,
        metadata: {
          libraryItemId: clip.libraryItemId,
          licenceMode: 'FOOTAGE',
          hookFallback: reason,
        },
      },
    });
    const current = await tx.videoShot.findUniqueOrThrow({
      where: { id: shot.id },
      select: { providerRouting: true },
    });
    const routing = {
      providerId: 'video-library',
      libraryItemId: clip.libraryItemId,
      degradedFrom: 'actor_video',
      degradedReason: reason,
    };
    await tx.videoShot.update({
      where: { id: shot.id },
      data: {
        assetId: created.id,
        providerRouting: {
          ...((current.providerRouting as Record<string, unknown> | null) ?? {}),
          visual: routing,
        } as Prisma.InputJsonValue,
      },
    });
    return { id: created.id, routing };
  });
  deps.logger.warn(
    { projectId: shot.script.projectId, shotId: shot.id, reason },
    'no AI creator available; the hook uses a licensed library reaction clip',
  );
  return { assetId: asset.id, routing: asset.routing };
}

/**
 * 22.1: the hook shot's visual. `record` stores a provider output as the shot's asset (generate-
 * asset.ts recordAsset, so copy-to-storage, cost and the routing snapshot work as for any clip).
 */
export async function generateHookClip(
  deps: PipelineDeps,
  shot: HookShot,
  data: GenerateAssetJobData,
  marker: HookClipMarker,
  record: (run: ProviderRunResult, extra: Record<string, unknown>) => Promise<Stored>,
): Promise<Stored> {
  if (marker.leaderShotId) return followLeader(deps, shot, marker.leaderShotId);
  if (!canMakeSilentHook(deps.registry)) return libraryHookClip(deps, shot, 'not_configured');
  const actorImageUrl = await portraitUrl(deps, shot);
  let run: ProviderRunResult;
  try {
    run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'UGC_ACTOR', durationSec: HOOK_CLIP_SEC },
        planTier: data.planTier,
        request: {
          ...silentHookRequest(
            shot.script.targetAspectRatio as AspectRatio,
            hookClipPrompt({ reaction: marker.reaction, actorReference: Boolean(actorImageUrl) }),
          ),
          organisationId: data.organisationId,
          projectId: data.projectId,
          shotId: shot.id,
          ...(actorImageUrl && { actorImageUrl }),
        },
      },
      deps,
    );
  } catch (err) {
    const reason = avatarUnavailableReason(err);
    if (!reason) throw err;
    return libraryHookClip(deps, shot, reason);
  }
  return record(run, { [HOOK_CLIP_KEY]: true, silent: true, reaction: marker.reaction });
}
