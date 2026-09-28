import type { PrismaClient } from '@prisma/client';
import type { AssetStorage } from '../storage';

// BACKLOG 15.E2 (second half) — hard deletion of a purged business once its 30-day grace has
// passed (A11.7 "on business deletion, profile is deleted within 30 days"; spec 18.4 "purges all
// assets, renders, and analytics … within 30 days"). Run by the daily retention sweep (rule
// business_purge in services/retention.ts), never by a request.
//
// Order: S3 objects first, then rows, child tables before parents. If an object cannot be
// deleted the run stops before any row goes, so tomorrow's run finds the same keys again (no
// orphaned objects). Everything is scoped by (organisationId, businessId) and the business's
// project ids; image_library_queries (businessId only, no organisation column) and voice profiles
// (their clones must be revoked at ElevenLabs first) are deliberately not touched.

export interface ObjectRef {
  bucket: string;
  key: string;
}

export interface BusinessHardDeleteSummary {
  projects: number;
  rows: Record<string, number>;
  objects: number;
}

type Db = PrismaClient;

const isStored = (o: { bucket: string | null; key: string | null }): o is ObjectRef =>
  Boolean(o.bucket && o.key);

/** Delete objects (idempotent per S3). Throws on the first failure so rows are kept. */
export async function deleteObjects(storage: AssetStorage, objects: ObjectRef[]): Promise<number> {
  const unique = new Map(objects.map((o) => [`${o.bucket}\u0000${o.key}`, o]));
  for (const o of unique.values()) await storage.delete(o.bucket, o.key);
  return unique.size;
}

/** Buckets a render's thumbnail / captions key may live in (delete is idempotent). */
export function renderSidecarBuckets(
  render: { s3Bucket: string },
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    ...new Set(
      [render.s3Bucket, env.S3_BUCKET_THUMBNAILS, env.S3_BUCKET_ASSETS]
        .map((b) => b?.trim())
        .filter((b): b is string => Boolean(b)),
    ),
  ];
}

/** Asset objects of these projects that no row outside them still references (B6 reuse). */
export async function unsharedAssetObjects(db: Db, projectIds: string[]): Promise<ObjectRef[]> {
  const assets = await db.videoAsset.findMany({
    where: { projectId: { in: projectIds } },
    select: { s3Bucket: true, s3Key: true },
  });
  const refs = assets.map((a) => ({ bucket: a.s3Bucket, key: a.s3Key })).filter(isStored);
  if (refs.length === 0) return [];
  const shared = await db.videoAsset.findMany({
    where: {
      projectId: { notIn: projectIds },
      s3Key: { in: [...new Set(refs.map((r) => r.key))] },
    },
    select: { s3Bucket: true, s3Key: true },
  });
  const keep = new Set(shared.map((s) => `${s.s3Bucket}\u0000${s.s3Key}`));
  return refs.filter((r) => !keep.has(`${r.bucket}\u0000${r.key}`));
}

/** Every row hanging off these projects, children first. Returns rows deleted per table. */
export async function deleteProjectRows(db: Db, projectIds: string[]) {
  const rows: Record<string, number> = {};
  if (projectIds.length === 0) return rows;
  const count = (table: string, n: { count: number }) => {
    rows[table] = (rows[table] ?? 0) + n.count;
  };
  const pubIds = (
    await db.videoPublication.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const renderIds = (
    await db.videoRender.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const scriptIds = (
    await db.videoScript.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    })
  ).map((s) => s.id);
  const shotIds = (
    await db.videoShot.findMany({ where: { scriptId: { in: scriptIds } }, select: { id: true } })
  ).map((s) => s.id);
  await db.$transaction(async (tx) => {
    count(
      'video_analytics',
      await tx.videoAnalytic.deleteMany({ where: { publicationId: { in: pubIds } } }),
    );
    count(
      'scheduled_publications',
      await tx.scheduledPublication.deleteMany({ where: { publicationId: { in: pubIds } } }),
    );
    count(
      'publication_conversations',
      await tx.publicationConversation.deleteMany({ where: { publicationId: { in: pubIds } } }),
    );
    count(
      'calendar_shadows',
      await tx.calendarShadow.deleteMany({ where: { publicationId: { in: pubIds } } }),
    );
    count(
      'video_publications',
      await tx.videoPublication.deleteMany({ where: { id: { in: pubIds } } }),
    );
    count(
      'text_overlays',
      await tx.textOverlay.deleteMany({
        where: { OR: [{ shotId: { in: shotIds } }, { renderId: { in: renderIds } }] },
      }),
    );
    count('video_shots', await tx.videoShot.deleteMany({ where: { id: { in: shotIds } } }));
    count('video_scripts', await tx.videoScript.deleteMany({ where: { id: { in: scriptIds } } }));
    count(
      'video_briefs',
      await tx.videoBrief.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    // Slide overlays cascade with their slide (TextOverlay.slide onDelete: Cascade).
    count(
      'slideshow_slides',
      await tx.slideshowSlide.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count(
      'approval_tasks',
      await tx.approvalTask.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count(
      'auto_publish_outbox',
      await tx.autoPublishOutbox.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count(
      'safety_reviews',
      await tx.safetyReview.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count(
      'content_safety_tasks',
      await tx.contentSafetyTask.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    // Share-link comments cascade with their link.
    count(
      'share_links',
      await tx.shareLink.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count('video_renders', await tx.videoRender.deleteMany({ where: { id: { in: renderIds } } }));
    count(
      'video_assets',
      await tx.videoAsset.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count(
      'video_uploads',
      await tx.videoUpload.deleteMany({ where: { projectId: { in: projectIds } } }),
    );
    count(
      'video_projects',
      await tx.videoProject.deleteMany({ where: { id: { in: projectIds } } }),
    );
  });
  return rows;
}

/** Objects owned by these projects: renders (+ sidecars), unshared assets and uploads. */
export async function projectObjects(db: Db, projectIds: string[]): Promise<ObjectRef[]> {
  if (projectIds.length === 0) return [];
  const renders = await db.videoRender.findMany({
    where: { projectId: { in: projectIds } },
    select: { s3Bucket: true, s3Key: true, thumbnailS3Key: true, captionsSrtS3Key: true },
  });
  const uploads = await db.videoUpload.findMany({
    where: { projectId: { in: projectIds } },
    select: { s3Bucket: true, s3Key: true },
  });
  return [
    ...renders.flatMap((r) => [
      { bucket: r.s3Bucket, key: r.s3Key },
      ...[r.thumbnailS3Key, r.captionsSrtS3Key]
        .filter((k): k is string => Boolean(k))
        .flatMap((key) => renderSidecarBuckets(r).map((bucket) => ({ bucket, key }))),
    ]),
    ...uploads.map((u) => ({ bucket: u.s3Bucket, key: u.s3Key })),
    ...(await unsharedAssetObjects(db, projectIds)),
  ].filter(isStored);
}

export async function hardDeleteBusiness(
  deps: { db: Db; storage: AssetStorage },
  input: { organisationId: string; businessId: string },
): Promise<BusinessHardDeleteSummary> {
  const { db } = deps;
  const { organisationId, businessId } = input;
  const projectIds = (
    await db.videoProject.findMany({ where: { organisationId, businessId }, select: { id: true } })
  ).map((p) => p.id);
  const images = await db.imageLibraryItem.findMany({
    where: { organisationId, businessId },
    select: { s3Bucket: true, s3Key: true },
  });
  // Uploads not attached to a project (a source video never used, 13.5).
  const looseUploads = await db.videoUpload.findMany({
    where: { organisationId, businessId, projectId: null },
    select: { s3Bucket: true, s3Key: true },
  });
  const objects = await deleteObjects(deps.storage, [
    ...(await projectObjects(db, projectIds)),
    ...[...images, ...looseUploads]
      .map((i) => ({ bucket: i.s3Bucket, key: i.s3Key }))
      .filter(isStored),
  ]);
  const rows = await deleteProjectRows(db, projectIds);
  const scope = { organisationId, businessId };
  const business = await db.$transaction(async (tx) => ({
    image_library: (await tx.imageLibraryItem.deleteMany({ where: scope })).count,
    video_uploads_unattached: (
      await tx.videoUpload.deleteMany({ where: { ...scope, projectId: null } })
    ).count,
    brand_kits: (await tx.brandKit.deleteMany({ where: scope })).count,
    business_profiles: (await tx.businessProfile.deleteMany({ where: scope })).count,
    website_scans: (await tx.websiteScan.deleteMany({ where: scope })).count,
    domain_verifications: (await tx.domainVerification.deleteMany({ where: scope })).count,
    style_memories: (await tx.styleMemory.deleteMany({ where: scope })).count,
    overlay_presets: (await tx.overlayPreset.deleteMany({ where: { ...scope, scope: 'BUSINESS' } }))
      .count,
    platform_connections: (await tx.platformConnection.deleteMany({ where: scope })).count,
  }));
  return { projects: projectIds.length, rows: { ...rows, ...business }, objects };
}
