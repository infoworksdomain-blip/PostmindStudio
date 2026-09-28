import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AssetStorage } from '../storage';

// BACKLOG 14.2 — abandoned browser uploads. A 13.5 upload is PENDING from POST /uploads until
// /complete; if the browser never completes it, the object (if the PUT happened at all) sits
// under orgs/<org>/uploads/<id>/ forever. An S3 lifecycle rule cannot tell those objects from
// READY uploads (the footage of UPLOAD projects and slideshow clips, which must never expire —
// runbooks/deploy.md), so the sweep is app logic: once the presigned PUT URL has been expired
// for ABANDONED_AFTER_MS, the object is deleted and the row marked FAILED. READY and FAILED rows
// are never touched (FAILED uploads are deleted at /complete when rejected).

export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_SWEEP_SCHEDULE = '45 1 * * *'; // 01:45 UTC daily
const BATCH = 200;
export const ABANDONED_REASON = 'abandoned: the upload was never completed';

export async function sweepAbandonedUploads(deps: {
  db: PrismaClient;
  storage: AssetStorage;
  now: () => number;
  logger: Logger;
}): Promise<{ swept: number }> {
  const cutoff = new Date(deps.now() - ABANDONED_AFTER_MS);
  let swept = 0;
  for (;;) {
    const batch = await deps.db.videoUpload.findMany({
      where: { state: 'PENDING', expiresAt: { lt: cutoff } },
      select: { id: true, s3Bucket: true, s3Key: true },
      orderBy: { expiresAt: 'asc' },
      take: BATCH,
    });
    for (const upload of batch) {
      // Idempotent: deleting a key that was never PUT succeeds.
      await deps.storage.delete(upload.s3Bucket, upload.s3Key);
      const marked = await deps.db.videoUpload.updateMany({
        where: { id: upload.id, state: 'PENDING' },
        data: { state: 'FAILED', errorReason: ABANDONED_REASON },
      });
      swept += marked.count;
    }
    if (batch.length < BATCH) break;
  }
  if (swept) deps.logger.info({ swept }, 'abandoned uploads swept');
  return { swept };
}
