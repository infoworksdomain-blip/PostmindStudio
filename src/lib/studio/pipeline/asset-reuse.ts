import { createHash } from 'node:crypto';
import type { AssetKind, Prisma, VideoAsset } from '@prisma/client';
import { planCandidates, type PlanTier, type RouteNeed } from '../providers/router';
import type { PipelineDeps } from './deps';

// BACKLOG 15.B6 — spec 5.4 "we reuse rather than regenerate — direct cost saving". Every
// generated clip, still and narration gets video_assets.fingerprint = sha256 of what determines
// the output: provider, capability, normalised prompt/text, duration, aspect ratio and seed
// (source image or voice). Before paying for a generation, the organisation's assets are searched
// for the fingerprint under each provider the router could use for this tier (in its order); a
// stored match is reused: a new video_assets row pointing at the same object, and a zero-cost
// provider_jobs row marked reused (operation "<capability>:reused"), so spend reports show the
// saving. A shot being regenerated (it already has a visual routing snapshot) never reuses.

export interface FingerprintInput {
  capability: string;
  /** Generation prompt (visuals) or narration text (TTS). */
  prompt: string;
  durationSec?: number | null;
  aspectRatio?: string | null;
  /** Seed image / voice id / speed: anything else that changes the output. */
  seed?: string | null;
}

/** Visual prompts are compared case- and whitespace-insensitively; narration text exactly. */
export function normalisePrompt(capability: string, prompt: string): string {
  const collapsed = prompt.trim().replace(/\s+/g, ' ');
  return capability === 'tts' ? collapsed : collapsed.toLowerCase();
}

export function assetFingerprint(providerId: string, input: FingerprintInput): string {
  const canonical = JSON.stringify([
    'v1',
    providerId,
    input.capability,
    normalisePrompt(input.capability, input.prompt),
    input.durationSec ?? null,
    input.aspectRatio ?? null,
    input.seed ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Providers the router may use for this need and tier, in preference order. */
export function candidateProviders(need: RouteNeed, tier: PlanTier): string[] {
  try {
    return planCandidates(need, tier).providerIds;
  } catch {
    return [];
  }
}

/** The newest reusable asset for any candidate provider (candidate order wins), or null. */
export async function findReusableAsset(
  deps: Pick<PipelineDeps, 'db' | 'storage'>,
  input: {
    organisationId: string;
    kind: AssetKind;
    providers: string[];
    fingerprint: FingerprintInput;
  },
): Promise<VideoAsset | null> {
  if (input.providers.length === 0 || !input.fingerprint.prompt.trim()) return null;
  const prints = input.providers.map((p) => assetFingerprint(p, input.fingerprint));
  const rows = await deps.db.videoAsset.findMany({
    where: { organisationId: input.organisationId, kind: input.kind, fingerprint: { in: prints } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  if (rows.length === 0) return null;
  const live = new Set(
    (
      await deps.db.videoProject.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.projectId))] }, deletedAt: null },
        select: { id: true },
      })
    ).map((p) => p.id),
  );
  for (const print of prints) {
    for (const row of rows.filter((r) => r.fingerprint === print && live.has(r.projectId))) {
      try {
        if ((await deps.storage.size(row.s3Bucket, row.s3Key)) > 0) return row;
      } catch {
        // Stored object gone (retention/purge): not reusable.
      }
    }
  }
  return null;
}

/** Provider id recorded in a reused asset's `source` ("runway:gen4" → "runway"). */
export function providerOfSource(source: string): string {
  return source.split(':')[0] ?? source;
}

/**
 * Record the reuse for a shot: a zero-cost provider_jobs row marked reused, a new video_assets
 * row pointing at the same object, and the shot's pointer + routing snapshot (one transaction).
 */
export async function reuseAssetForShot(
  deps: Pick<PipelineDeps, 'db' | 'now'>,
  input: {
    source: VideoAsset;
    shotId: string;
    projectId: string;
    capability: string;
    pointer: 'assetId' | 'voiceAssetId';
    routingKey: 'visual' | 'voice';
  },
): Promise<VideoAsset> {
  const { source } = input;
  const providerId = providerOfSource(source.source);
  const at = new Date(deps.now());
  const metadata =
    source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
      ? { ...(source.metadata as Record<string, unknown>) }
      : {};
  delete metadata.fit; // narration fit depends on the shot; it is decided again
  return deps.db.$transaction(async (tx) => {
    const job = await tx.providerJob.create({
      data: {
        organisationId: source.organisationId,
        projectId: input.projectId,
        provider: providerId,
        operation: `${input.capability}:reused`,
        requestBody: { reused: true, fingerprint: source.fingerprint, fromAssetId: source.id },
        responseBody: { reusedAssetId: source.id, savedPence: source.costPence },
        state: 'SUCCEEDED',
        startedAt: at,
        completedAt: at,
        durationMs: 0,
        costPence: 0,
      },
    });
    const asset = await tx.videoAsset.create({
      data: {
        organisationId: source.organisationId,
        projectId: input.projectId,
        shotId: input.shotId,
        kind: source.kind,
        source: source.source,
        s3Bucket: source.s3Bucket,
        s3Key: source.s3Key,
        durationSec: source.durationSec,
        widthPx: source.widthPx,
        heightPx: source.heightPx,
        fileSizeBytes: source.fileSizeBytes,
        fingerprint: source.fingerprint,
        providerJobId: job.id,
        costPence: 0,
        metadata: {
          ...metadata,
          reusedFromAssetId: source.id,
          savedPence: source.costPence,
        } as Prisma.InputJsonValue,
      },
    });
    const shot = await tx.videoShot.findUniqueOrThrow({
      where: { id: input.shotId },
      select: { providerRouting: true },
    });
    await tx.videoShot.update({
      where: { id: input.shotId },
      data: {
        [input.pointer]: asset.id,
        providerRouting: {
          ...((shot.providerRouting as Record<string, unknown> | null) ?? {}),
          [input.routingKey]: {
            providerId,
            reused: true,
            reusedFromAssetId: source.id,
            candidates: [],
            decidedAt: at.toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
    return asset;
  });
}
