import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { ConfigurationError } from '../../errors';
import { UPLOADED_FONT_PREFIX } from '../pipeline/brand-resolve';
import type { AssetStorage } from '../storage';

// BACKLOG 14.2 / 17.1 — abandoned browser uploads. A 13.5 upload is PENDING from POST /uploads
// until /complete; if the browser never completes it, the object (if the PUT happened at all) sits
// under orgs/<org>/uploads/<id>/ forever. An S3 lifecycle rule cannot tell those objects from
// READY uploads (the footage of UPLOAD projects and slideshow clips, which must never expire —
// runbooks/deploy.md), so the sweep is app logic: once the presigned PUT URL has been expired
// for the grace period (STUDIO_UPLOAD_ABANDON_GRACE_HOURS, default 24), the object is deleted
// through the storage abstraction (S3 or R2) and the row marked FAILED (the upload state machine
// is PENDING → READY | FAILED; FAILED rows are what /complete leaves for rejected files too).
// READY and FAILED rows are never touched. 17.1: neither is a PENDING row whose upload or object
// is referenced by anything (a project, a video asset / slide, a brand kit): those are skipped
// and logged for an operator, since deleting them could break a project.

export const DEFAULT_ABANDON_GRACE_HOURS = 24;
export const MAX_ABANDON_GRACE_HOURS = 30 * 24;
export const ABANDONED_AFTER_MS = DEFAULT_ABANDON_GRACE_HOURS * 60 * 60 * 1000;
export const UPLOAD_SWEEP_SCHEDULE = '45 1 * * *'; // 01:45 UTC daily
const BATCH = 200;
export const ABANDONED_REASON = 'abandoned: the upload was never completed';

/** STUDIO_UPLOAD_ABANDON_GRACE_HOURS: whole hours after the PUT URL expired, 1–720 (default 24). */
export function uploadAbandonGraceMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.STUDIO_UPLOAD_ABANDON_GRACE_HOURS?.trim();
  if (!raw) return ABANDONED_AFTER_MS;
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_ABANDON_GRACE_HOURS) {
    throw new ConfigurationError(
      `STUDIO_UPLOAD_ABANDON_GRACE_HOURS must be a whole number of hours from 1 to ${MAX_ABANDON_GRACE_HOURS}`,
    );
  }
  return hours * 60 * 60 * 1000;
}

interface Candidate {
  id: string;
  kind: string;
  projectId: string | null;
  assetId: string | null;
  s3Bucket: string;
  s3Key: string;
}

type RefDb = Pick<PrismaClient, 'videoProject' | 'videoAsset' | 'brandKit'>;

/**
 * The candidates something still points at. A PENDING upload normally has no references (a
 * project or brand kit can only claim a READY one), so any hit means the row is not what it
 * seems and must be left for a person:
 *   - the row itself records an asset, or (source videos) the project that claimed it; a slide
 *     clip's projectId is the slideshow it was uploaded to, set at creation, not a claim;
 *   - an UPLOAD project whose sourceRef is the upload;
 *   - a video asset (a slideshow slide's clip, or a project's footage) on the same object;
 *   - a brand kit using it as logo / watermark / card, or as an uploaded font ("upload:<id>").
 */
export async function referencedUploads(db: RefDb, uploads: Candidate[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const u of uploads) {
    if (u.assetId || (u.kind === 'SOURCE_VIDEO' && u.projectId)) referenced.add(u.id);
  }
  const ids = uploads.map((u) => u.id);
  if (ids.length === 0) return referenced;
  const [projects, assets, kits] = await Promise.all([
    db.videoProject.findMany({
      where: { sourceType: 'UPLOAD', sourceRef: { in: ids } },
      select: { sourceRef: true },
    }),
    db.videoAsset.findMany({
      where: { s3Key: { in: uploads.map((u) => u.s3Key) } },
      select: { s3Bucket: true, s3Key: true },
    }),
    db.brandKit.findMany({
      where: {
        OR: [
          { logoAssetId: { in: ids } },
          { watermarkAssetId: { in: ids } },
          { introCardAssetId: { in: ids } },
          { outroCardAssetId: { in: ids } },
          { fontPrimary: { in: ids.map((id) => `${UPLOADED_FONT_PREFIX}${id}`) } },
          { fontSecondary: { in: ids.map((id) => `${UPLOADED_FONT_PREFIX}${id}`) } },
        ],
      },
      select: {
        logoAssetId: true,
        watermarkAssetId: true,
        introCardAssetId: true,
        outroCardAssetId: true,
        fontPrimary: true,
        fontSecondary: true,
      },
    }),
  ]);
  for (const p of projects) if (p.sourceRef) referenced.add(p.sourceRef);
  const objects = new Set(assets.map((a) => `${a.s3Bucket}/${a.s3Key}`));
  for (const u of uploads) if (objects.has(`${u.s3Bucket}/${u.s3Key}`)) referenced.add(u.id);
  const idSet = new Set(ids);
  for (const kit of kits) {
    const fonts = [kit.fontPrimary, kit.fontSecondary].map((f) =>
      f?.startsWith(UPLOADED_FONT_PREFIX) ? f.slice(UPLOADED_FONT_PREFIX.length) : null,
    );
    for (const value of [
      kit.logoAssetId,
      kit.watermarkAssetId,
      kit.introCardAssetId,
      kit.outroCardAssetId,
      ...fonts,
    ]) {
      if (value && idSet.has(value)) referenced.add(value);
    }
  }
  return referenced;
}

export async function sweepAbandonedUploads(deps: {
  db: PrismaClient;
  storage: AssetStorage;
  now: () => number;
  logger: Logger;
  /** Defaults to STUDIO_UPLOAD_ABANDON_GRACE_HOURS. */
  graceMs?: number;
}): Promise<{ swept: number; skippedReferenced: string[] }> {
  const cutoff = new Date(deps.now() - (deps.graceMs ?? uploadAbandonGraceMs()));
  let swept = 0;
  const skippedReferenced: string[] = [];
  // Keyset pagination on (expiresAt, id): skipped rows stay PENDING and must not be re-read.
  let after: { expiresAt: Date; id: string } | undefined;
  for (;;) {
    const batch = await deps.db.videoUpload.findMany({
      where: {
        state: 'PENDING',
        expiresAt: { lt: cutoff },
        ...(after && {
          OR: [
            { expiresAt: { gt: after.expiresAt } },
            { expiresAt: after.expiresAt, id: { gt: after.id } },
          ],
        }),
      },
      select: {
        id: true,
        kind: true,
        projectId: true,
        assetId: true,
        s3Bucket: true,
        s3Key: true,
        expiresAt: true,
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: BATCH,
    });
    const referenced = await referencedUploads(deps.db, batch);
    for (const upload of batch) {
      if (referenced.has(upload.id)) {
        skippedReferenced.push(upload.id);
        continue;
      }
      // Claim the row first (PENDING → FAILED): a late /complete then sees a rejected upload
      // instead of probing an object that is being deleted.
      const marked = await deps.db.videoUpload.updateMany({
        where: { id: upload.id, state: 'PENDING' },
        data: { state: 'FAILED', errorReason: ABANDONED_REASON },
      });
      if (marked.count === 0) continue;
      try {
        // Idempotent: deleting a key that was never PUT succeeds.
        await deps.storage.delete(upload.s3Bucket, upload.s3Key);
      } catch (err) {
        // Put the row back so the retry (and tomorrow's run) finds the object again.
        await deps.db.videoUpload.updateMany({
          where: { id: upload.id, state: 'FAILED', errorReason: ABANDONED_REASON },
          data: { state: 'PENDING', errorReason: null },
        });
        throw err;
      }
      swept += 1;
    }
    const last = batch.at(-1);
    if (batch.length < BATCH || !last) break;
    after = { expiresAt: last.expiresAt, id: last.id };
  }
  if (skippedReferenced.length)
    deps.logger.warn(
      { uploadIds: skippedReferenced.slice(0, 50), count: skippedReferenced.length },
      'abandoned uploads left in place: still referenced (check them by hand)',
    );
  if (swept) deps.logger.info({ swept }, 'abandoned uploads swept');
  return { swept, skippedReferenced };
}
