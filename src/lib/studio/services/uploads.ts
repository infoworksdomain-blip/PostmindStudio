import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VideoUpload } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { MediaProbe } from '../pipeline/media-probe';
import type { UploadDeps } from '../uploads/signer';
import {
  apiKindOf,
  BRAND_CONTENT_TYPES,
  BRAND_EXTENSION,
  BRAND_KINDS,
  BRAND_LIMITS,
  brandCreateProblem,
  checkBrandFile,
  isBrandKind,
  isBrandUploadKind,
  UPLOAD_KIND_ENUM,
} from './brand-uploads';

// Phase 13.5 — "Upload your own video" (sourceType UPLOAD) and slideshow clip upload.
//   POST /uploads → a presigned S3 PUT (the file never passes through Studio), with type and
//     size limits per kind;
//   POST /uploads/:id/complete → HEAD for the real size, ffprobe (pipeline/media-probe.ts), then
//     READY. A slide clip becomes a video_assets row of its slideshow at once; a source video's
//     asset is created when POST /projects { sourceType: UPLOAD, uploadId } uses it.

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export const UPLOAD_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
/** File extension per accepted upload type (also the corpus scan's accepted formats). */
export const UPLOAD_VIDEO_EXTENSION: Record<(typeof UPLOAD_CONTENT_TYPES)[number], string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export const UPLOAD_LIMITS = {
  source_video: { maxBytes: 500 * 1024 * 1024, minSec: 1, maxSec: 600 },
  slide_clip: { maxBytes: 200 * 1024 * 1024, minSec: 0.5, maxSec: 120 },
} as const;
export const PUT_URL_TTL_SEC = 15 * 60;
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const SLIDE_UPLOAD_STATES = ['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW'];

type Kind = keyof typeof UPLOAD_LIMITS;

const ALL_CONTENT_TYPES = [
  ...new Set([...UPLOAD_CONTENT_TYPES, ...Object.values(BRAND_CONTENT_TYPES).flat()]),
] as [string, ...string[]];

export const createUploadInput = z
  .object({
    kind: z.enum(['source_video', 'slide_clip', ...BRAND_KINDS]),
    contentType: z.enum(ALL_CONTENT_TYPES),
    sizeBytes: z.number().int().positive(),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^/\\\u0000-\u001f]+$/, 'fileName must be a plain file name'),
    /** source_video: the business the video is for (optional; checked again on project use). */
    businessId: z.string().trim().min(1).max(128).optional(),
    /** slide_clip: the slideshow project the clip belongs to. */
    projectId: z.string().trim().min(1).max(64).optional(),
    /** 15.B1 brand_font: A11.5 licence confirmation for commercial embedding (must be true). */
    licenceConfirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'slide_clip' && !v.projectId)
      ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'projectId is required' });
    if (isBrandKind(v.kind)) {
      const problem = brandCreateProblem({ ...v, kind: v.kind });
      if (problem) ctx.addIssue({ code: 'custom', path: ['kind'], message: problem });
    } else if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(v.contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: `contentType must be one of ${UPLOAD_CONTENT_TYPES.join(', ')}`,
      });
    }
  });

export function presentUpload(upload: VideoUpload) {
  return {
    id: upload.id,
    kind: apiKindOf(upload.kind),
    state: upload.state,
    fileName: upload.fileName,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes === null ? null : Number(upload.sizeBytes),
    durationSec: upload.durationSec,
    width: upload.widthPx,
    height: upload.heightPx,
    projectId: upload.projectId,
    assetId: upload.assetId,
    errorReason: upload.errorReason,
    expiresAt: upload.expiresAt.toISOString(),
    fontFamily: upload.fontFamily,
    licenceConfirmedAt: upload.licenceConfirmedAt?.toISOString() ?? null,
  };
}

export async function createUpload(
  deps: { db: Db; uploads: UploadDeps; now: () => number },
  tenant: TenantContext,
  input: z.infer<typeof createUploadInput>,
) {
  const brand = isBrandKind(input.kind) ? input.kind : null;
  const limits = brand ? BRAND_LIMITS[brand] : UPLOAD_LIMITS[input.kind as Kind];
  if (input.sizeBytes > limits.maxBytes)
    throw new PayloadTooLargeError(
      `${brand ? 'Files' : 'Videos'} can be at most ${Math.round(limits.maxBytes / 1024 / 1024)} MB`,
    );
  if (!SAFE_SEGMENT.test(tenant.organisationId))
    throw new ValidationError('Organisation id is not usable in a storage key');
  let businessId = input.businessId ?? null;
  if (input.kind === 'slide_clip') {
    const project = await deps.db.videoProject.findFirst({
      where: { id: input.projectId, organisationId: tenant.organisationId, deletedAt: null },
    });
    if (!project) throw new NotFoundError('Project not found');
    if (project.sourceType !== 'SLIDESHOW')
      throw new ConflictError('Clips can only be uploaded to a slideshow');
    if (!SLIDE_UPLOAD_STATES.includes(project.state))
      throw new ConflictError(`Slides cannot be edited while the project is ${project.state}`);
    businessId = project.businessId;
  }
  const id = randomUUID();
  const key = brand
    ? `orgs/${tenant.organisationId}/brand/${id}/file.${BRAND_EXTENSION[input.contentType] ?? 'bin'}`
    : `orgs/${tenant.organisationId}/uploads/${id}/source.${UPLOAD_VIDEO_EXTENSION[input.contentType as keyof typeof UPLOAD_VIDEO_EXTENSION]}`;
  const expiresAt = new Date(deps.now() + PUT_URL_TTL_SEC * 1000);
  const putUrl = await deps.uploads.signer.presignPut({
    bucket: deps.uploads.bucket,
    key,
    contentType: input.contentType,
    expiresInSec: PUT_URL_TTL_SEC,
  });
  const upload = await deps.db.videoUpload.create({
    data: {
      id,
      organisationId: tenant.organisationId,
      businessId,
      createdByUserId: tenant.userId,
      kind: brand
        ? UPLOAD_KIND_ENUM[brand]
        : input.kind === 'source_video'
          ? 'SOURCE_VIDEO'
          : 'SLIDE_CLIP',
      projectId: input.kind === 'slide_clip' ? (input.projectId ?? null) : null,
      fileName: input.fileName,
      contentType: input.contentType,
      declaredBytes: BigInt(input.sizeBytes),
      s3Bucket: deps.uploads.bucket,
      s3Key: key,
      expiresAt,
      ...(brand === 'brand_font' && { licenceConfirmedAt: new Date(deps.now()) }),
    },
  });
  return {
    upload: {
      ...presentUpload(upload),
      putUrl,
      maxBytes: limits.maxBytes,
      /** The PUT must carry exactly these headers (Content-Type is signed). */
      headers: { 'content-type': input.contentType },
    },
  };
}

/** Why a probed file is not usable, or null when it is. */
export function probeProblem(kind: Kind, probe: MediaProbe): string | null {
  const limits = UPLOAD_LIMITS[kind];
  if (!(probe.width > 0 && probe.height > 0)) return 'the file has no video stream';
  if (!(probe.durationSec >= limits.minSec))
    return `the video must be at least ${limits.minSec}s long`;
  if (probe.durationSec > limits.maxSec)
    return `the video must be at most ${limits.maxSec / 60} minutes long`;
  return null;
}

async function reject(deps: { db: Db; uploads: UploadDeps }, upload: VideoUpload, reason: string) {
  await deps.uploads.storage.delete(upload.s3Bucket, upload.s3Key).catch(() => undefined);
  await deps.db.videoUpload.update({
    where: { id: upload.id },
    data: { state: 'FAILED', errorReason: reason.slice(0, 500) },
  });
}

export async function completeUpload(
  deps: { db: Db; uploads: UploadDeps; now: () => number },
  organisationId: string,
  id: string,
) {
  const upload = await deps.db.videoUpload.findFirst({ where: { id, organisationId } });
  if (!upload) throw new NotFoundError('Upload not found');
  if (upload.state === 'FAILED')
    throw new ConflictError(`This upload was rejected: ${upload.errorReason ?? 'unknown'}`);
  if (upload.state === 'READY') return completed(deps.db, upload);
  if (isBrandUploadKind(upload.kind)) return completeBrandUpload(deps, upload);

  const kind: Kind = upload.kind === 'SOURCE_VIDEO' ? 'source_video' : 'slide_clip';
  let size: number;
  try {
    size = await deps.uploads.storage.size(upload.s3Bucket, upload.s3Key);
  } catch {
    throw new ValidationError('The file has not been uploaded yet');
  }
  if (size > UPLOAD_LIMITS[kind].maxBytes) {
    await reject(deps, upload, 'file too large');
    throw new PayloadTooLargeError('The uploaded file is larger than allowed and was removed');
  }
  let probe: MediaProbe;
  try {
    probe = await deps.uploads.media.probe(
      await deps.uploads.storage.signedUrl(upload.s3Bucket, upload.s3Key),
    );
  } catch {
    await reject(deps, upload, 'not a readable video');
    throw new ValidationError('The uploaded file is not a readable video and was removed');
  }
  const problem = probeProblem(kind, probe);
  if (problem) {
    await reject(deps, upload, problem);
    throw new ValidationError(`The uploaded video was rejected: ${problem}`);
  }
  const ready = await deps.db.$transaction(async (tx) => {
    const asset =
      upload.kind === 'SLIDE_CLIP' && upload.projectId
        ? await createUploadAsset(tx, upload, upload.projectId, {
            durationSec: probe.durationSec,
            width: probe.width,
            height: probe.height,
            sizeBytes: size,
            videoCodec: probe.videoCodec,
            audioCodec: probe.audioCodec,
          })
        : null;
    return tx.videoUpload.update({
      where: { id: upload.id },
      data: {
        state: 'READY',
        durationSec: probe.durationSec,
        widthPx: probe.width,
        heightPx: probe.height,
        sizeBytes: BigInt(size),
        completedAt: new Date(deps.now()),
        ...(asset && { assetId: asset.id }),
      },
    });
  });
  return completed(deps.db, ready);
}

/** 15.B1: size + byte-level checks for brand-kit media (services/brand-uploads.ts). */
async function completeBrandUpload(
  deps: { db: Db; uploads: UploadDeps; now: () => number },
  upload: VideoUpload,
) {
  let size: number;
  try {
    size = await deps.uploads.storage.size(upload.s3Bucket, upload.s3Key);
  } catch {
    throw new ValidationError('The file has not been uploaded yet');
  }
  const limit = BRAND_LIMITS[apiKindOf(upload.kind) as keyof typeof BRAND_LIMITS].maxBytes;
  if (size > limit) {
    await reject(deps, upload, 'file too large');
    throw new PayloadTooLargeError('The uploaded file is larger than allowed and was removed');
  }
  let checked;
  try {
    checked = await checkBrandFile(deps.uploads, upload, size);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    await reject(deps, upload, err.message);
    throw new ValidationError(`The uploaded file was rejected: ${err.message}`);
  }
  const ready = await deps.db.videoUpload.update({
    where: { id: upload.id },
    data: {
      state: 'READY',
      sizeBytes: BigInt(size),
      widthPx: checked.widthPx ?? null,
      heightPx: checked.heightPx ?? null,
      durationSec: checked.durationSec ?? null,
      fontFamily: checked.fontFamily ?? null,
      completedAt: new Date(deps.now()),
    },
  });
  return completed(deps.db, ready);
}

async function completed(db: Db, upload: VideoUpload) {
  const asset = upload.assetId
    ? await db.videoAsset.findFirst({
        where: { id: upload.assetId, organisationId: upload.organisationId },
      })
    : null;
  return {
    upload: presentUpload(upload),
    asset: asset
      ? {
          id: asset.id,
          durationSec: asset.durationSec,
          width: asset.widthPx,
          height: asset.heightPx,
        }
      : null,
  };
}

async function createUploadAsset(
  tx: Tx,
  upload: VideoUpload,
  projectId: string,
  media: {
    durationSec: number | null;
    width: number | null;
    height: number | null;
    sizeBytes: number | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
  },
) {
  return tx.videoAsset.create({
    data: {
      organisationId: upload.organisationId,
      projectId,
      kind: 'VIDEO_CLIP',
      source: 'upload',
      s3Bucket: upload.s3Bucket,
      s3Key: upload.s3Key,
      durationSec: media.durationSec,
      widthPx: media.width,
      heightPx: media.height,
      fileSizeBytes: media.sizeBytes === null ? null : BigInt(media.sizeBytes),
      metadata: {
        uploadId: upload.id,
        fileName: upload.fileName,
        videoCodec: media.videoCodec ?? null,
        audioCodec: media.audioCodec ?? null,
      },
    },
  });
}

/**
 * POST /projects { sourceType: UPLOAD, uploadId }: claim a READY source video for the new
 * project (once) and record its asset. Runs inside the project-creation transaction.
 */
export async function attachSourceUpload(
  tx: Tx,
  input: { organisationId: string; businessId: string; uploadId: string; projectId: string },
): Promise<{ assetId: string }> {
  const upload = await tx.videoUpload.findFirst({
    where: { id: input.uploadId, organisationId: input.organisationId },
  });
  if (!upload || upload.kind !== 'SOURCE_VIDEO')
    throw new ValidationError('uploadId is not an uploaded source video');
  if (upload.state !== 'READY')
    throw new ValidationError('The upload is not complete (POST /uploads/:id/complete first)');
  if (upload.businessId && upload.businessId !== input.businessId)
    throw new ValidationError('The upload belongs to another business');
  const asset = await createUploadAsset(tx, upload, input.projectId, {
    durationSec: upload.durationSec,
    width: upload.widthPx,
    height: upload.heightPx,
    sizeBytes: upload.sizeBytes === null ? null : Number(upload.sizeBytes),
  });
  const claimed = await tx.videoUpload.updateMany({
    where: { id: upload.id, projectId: null },
    data: { projectId: input.projectId, assetId: asset.id },
  });
  if (claimed.count === 0) throw new ConflictError('This upload is already used by a project');
  return { assetId: asset.id };
}
