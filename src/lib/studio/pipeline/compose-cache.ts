import type { PrismaClient, VideoRender } from '@prisma/client';
import type { AssetStorage } from '../storage';
import type { CompositionSummary } from './composition-summary';
import { storedEdlHash } from './edl-hash';

// BACKLOG 15.B6 — composition cache. compose-video hashes the final edit (edl-hash.ts); when a
// render of the same project and platform was made from an identical edit and its file is still
// stored, the run re-points to that render instead of paying Shotstack again (spec 5.7).

export function withEdlHash(
  summary: CompositionSummary | null,
  hash: string,
): Record<string, unknown> {
  return summary ? { ...summary, edlHash: hash } : { edlHash: hash };
}

export async function findCachedRender(
  deps: { db: Pick<PrismaClient, 'videoRender'>; storage: Pick<AssetStorage, 'size'> },
  input: { projectId: string; targetPlatform: string; edlHash: string },
): Promise<VideoRender | null> {
  const candidates = await deps.db.videoRender.findMany({
    where: { projectId: input.projectId, targetPlatform: input.targetPlatform },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  for (const render of candidates) {
    if (storedEdlHash(render.composition) !== input.edlHash) continue;
    try {
      if ((await deps.storage.size(render.s3Bucket, render.s3Key)) > 0) return render;
    } catch {
      // The file is gone (retention or purge): render again.
    }
  }
  return null;
}
