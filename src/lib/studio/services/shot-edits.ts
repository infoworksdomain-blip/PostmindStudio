import type { PrismaClient, VisualTreatment } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { businessVideoAssets } from '../slideshow/resolve';
import { getScript } from './shots';
import { assertScriptEditable, markRendersStale } from './stale-renders';

// Phase 13.2 — shot asset swap and delete (spec 14.2). Neither starts a run: the current renders
// are marked stale and the owner re-renders (POST /renders/:id/rerender) when ready, so several
// edits cost one composition.

export const swapShotAssetInput = z
  .object({
    /** A clip or image already produced for this business (video_assets). */
    assetId: z.string().trim().min(1).max(64).optional(),
    /** An image from this business's image library (image_library). */
    imageLibraryId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.assetId) !== Boolean(v.imageLibraryId), {
    message: 'Give exactly one of assetId or imageLibraryId',
  });

export type SwapShotAssetInput = z.infer<typeof swapShotAssetInput>;

export function isSwapRequest(body: unknown): boolean {
  return (
    Boolean(body) &&
    typeof body === 'object' &&
    ('assetId' in (body as object) || 'imageLibraryId' in (body as object))
  );
}

async function loadShotForEdit(db: PrismaClient, organisationId: string, id: string) {
  const shot = await db.videoShot.findFirst({
    where: { id, script: { project: { organisationId, deletedAt: null } } },
    include: { script: { include: { project: true } } },
  });
  if (!shot) throw new NotFoundError('Shot not found');
  assertScriptEditable(shot.script.project.state);
  return shot;
}

/** The visual treatment that makes the composer show the new asset. */
export function treatmentFor(kind: 'VIDEO_CLIP' | 'IMAGE'): VisualTreatment {
  return kind === 'IMAGE' ? 'IMAGE_STILL' : 'USER_UPLOAD';
}

async function resolveSwapAsset(
  db: PrismaClient,
  scope: { organisationId: string; businessId: string; projectId: string; shotId: string },
  input: SwapShotAssetInput,
): Promise<{ id: string; kind: 'VIDEO_CLIP' | 'IMAGE' }> {
  if (input.assetId) {
    const asset = await db.videoAsset.findFirst({
      where: {
        id: input.assetId,
        organisationId: scope.organisationId,
        kind: { in: ['VIDEO_CLIP', 'IMAGE'] },
      },
    });
    if (!asset) throw new ValidationError('assetId is not a clip or image of this organisation');
    // Clips/images must come from a project of the same business (like slideshow clips).
    const allowed =
      asset.kind === 'VIDEO_CLIP'
        ? (await businessVideoAssets(db, scope, [asset.id])).length === 1
        : Boolean(
            await db.videoProject.findFirst({
              where: {
                id: asset.projectId,
                organisationId: scope.organisationId,
                businessId: scope.businessId,
                deletedAt: null,
              },
              select: { id: true },
            }),
          );
    if (!allowed) throw new ValidationError('assetId does not belong to this business');
    return { id: asset.id, kind: asset.kind as 'VIDEO_CLIP' | 'IMAGE' };
  }
  const item = await db.imageLibraryItem.findFirst({
    where: {
      id: input.imageLibraryId,
      organisationId: scope.organisationId,
      businessId: scope.businessId,
    },
  });
  if (!item) throw new ValidationError('imageLibraryId is not in this business’s image library');
  if (!item.s3Key)
    throw new ValidationError('This stock image is hotlink-only and cannot be used in a shot');
  const asset = await db.videoAsset.create({
    data: {
      organisationId: scope.organisationId,
      projectId: scope.projectId,
      shotId: scope.shotId,
      kind: 'IMAGE',
      source: `image-library:${item.id}`,
      s3Bucket: item.s3Bucket,
      s3Key: item.s3Key,
      widthPx: item.widthPx ?? null,
      heightPx: item.heightPx ?? null,
      metadata: { imageLibraryId: item.id },
    },
  });
  return { id: asset.id, kind: 'IMAGE' };
}

/** PATCH /shots/:id { assetId | imageLibraryId } — swap the shot's visual; renders go stale. */
export async function swapShotAsset(
  db: PrismaClient,
  organisationId: string,
  id: string,
  input: SwapShotAssetInput,
) {
  const shot = await loadShotForEdit(db, organisationId, id);
  const project = shot.script.project;
  const asset = await resolveSwapAsset(
    db,
    { organisationId, businessId: project.businessId, projectId: project.id, shotId: id },
    input,
  );
  const routing = (shot.providerRouting as Record<string, unknown> | null) ?? {};
  return db.$transaction(async (tx) => {
    const staleRenders = await markRendersStale(tx, project);
    const updated = await tx.videoShot.update({
      where: { id },
      data: {
        assetId: asset.id,
        visualTreatment: treatmentFor(asset.kind),
        state: 'READY',
        errorReason: null,
        providerRouting: {
          ...routing,
          swapped: {
            assetId: input.assetId ?? null,
            imageLibraryId: input.imageLibraryId ?? null,
            previousAssetId: shot.assetId,
          },
        },
      },
    });
    return { shot: updated, staleRenders };
  });
}

/** DELETE /shots/:id — remove a shot, re-time the script; 409 for the last shot. */
export async function deleteShot(db: PrismaClient, organisationId: string, id: string) {
  const shot = await loadShotForEdit(db, organisationId, id);
  const project = shot.script.project;
  await db.$transaction(async (tx) => {
    // Serialise shot mutations per project (sortOrder has no unique constraint).
    await tx.$queryRaw`SELECT id FROM studio.video_projects WHERE id = ${project.id} FOR UPDATE`;
    const remaining = await tx.videoShot.findMany({
      where: { scriptId: shot.scriptId, id: { not: id } },
      orderBy: { sortOrder: 'asc' },
    });
    if (remaining.length === 0)
      throw new ConflictError('A script needs at least one shot; delete the project instead');
    await markRendersStale(tx, project);
    await tx.textOverlay.deleteMany({ where: { shotId: id } });
    await tx.videoShot.delete({ where: { id } });
    for (const [index, s] of remaining.entries()) {
      if (s.sortOrder !== index)
        await tx.videoShot.update({ where: { id: s.id }, data: { sortOrder: index } });
    }
    const duration = remaining.reduce((sum, s) => sum + s.durationSec, 0);
    const narration = remaining
      .map((s) => s.voiceoverText?.trim())
      .filter((t): t is string => Boolean(t))
      .join(' ');
    await tx.videoScript.update({
      where: { id: shot.scriptId },
      data: {
        targetDurationSec: Math.max(1, Math.round(duration)),
        ...(narration && { fullText: narration }),
        version: { increment: 1 },
      },
    });
  });
  const after = await db.videoProject.findUniqueOrThrow({
    where: { id: project.id },
    select: { metadata: true },
  });
  const staleRenders = (after.metadata as { staleRenders?: string[] } | null)?.staleRenders ?? [];
  return { script: await getScript(db, organisationId, shot.scriptId), staleRenders };
}
