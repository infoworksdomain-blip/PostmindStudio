// Phase 13.5 demo: uploads (POST /uploads → presigned PUT → POST /uploads/:id/complete) and the
// UPLOAD project path. The "presigned" URL points back at the demo (/api/studio/demo-upload/:id),
// so the browser really PUTs the file; its duration comes from the file itself when the browser
// can read it (else a sample value). Same response shapes as services/uploads.ts.
import { DemoHttpError, route } from '../registry';
import type { ProjectContent } from './projects-content';
import { getProject, newId, type ProjectRec } from './projects-store';
import { completeBrandUpload, createBrandUpload, isBrandUploadRequest } from './p15-b-composition';

type Body = Record<string, unknown>;
const obj = (v: unknown): Body =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {};
const bad = (m: string) => new DemoHttpError(400, 'validation_error', m);

const TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
const MAX_BYTES = {
  source_video: 524_288_000,
  slide_clip: 209_715_200,
  // 22.1: a demo video for the business's demo bank (hook + demo videos).
  demo_video: 524_288_000,
} as const;
const SLIDE_EDITABLE = new Set([
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
]);

export interface DemoUpload {
  id: string;
  kind: 'source_video' | 'slide_clip' | 'demo_video';
  /** 22.1: the business a demo video belongs to. */
  businessId?: string | null;
  /** 22.1: when it was completed (the bank lists the newest first). */
  completedAt?: string | null;
  state: 'PENDING' | 'READY' | 'FAILED';
  fileName: string;
  contentType: string;
  sizeBytes: number | null;
  declaredBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  projectId: string | null;
  assetId: string | null;
  errorReason: string | null;
  expiresAt: string;
  received: boolean;
}

const uploads = new Map<string, DemoUpload>();

function present(u: DemoUpload) {
  const { declaredBytes: _d, received: _r, ...row } = u;
  return row;
}

route('POST', '/uploads', ({ body }) => {
  const b = obj(body);
  // 15.B1 (Track B): brand-kit media kinds.
  if (isBrandUploadRequest(b)) return createBrandUpload(b);
  const kind =
    b.kind === 'slide_clip'
      ? 'slide_clip'
      : b.kind === 'source_video'
        ? 'source_video'
        : b.kind === 'demo_video'
          ? 'demo_video'
          : null;
  if (!kind) throw bad('kind must be source_video, slide_clip or demo_video');
  if (kind === 'demo_video' && typeof b.businessId !== 'string')
    throw bad('businessId is required');
  const contentType = typeof b.contentType === 'string' ? b.contentType : '';
  if (!TYPES[contentType])
    throw bad('contentType must be video/mp4, video/quicktime or video/webm');
  const size = typeof b.sizeBytes === 'number' ? b.sizeBytes : 0;
  if (!(size > 0)) throw bad('sizeBytes is required');
  if (size > MAX_BYTES[kind])
    throw new DemoHttpError(
      413,
      'payload_too_large',
      `Videos can be at most ${Math.round(MAX_BYTES[kind] / 1024 / 1024)} MB`,
    );
  const fileName = typeof b.fileName === 'string' ? b.fileName.trim().slice(0, 200) : '';
  if (!fileName || fileName.includes('/') || fileName.includes('\\'))
    throw bad('fileName must be a plain file name');
  let projectId: string | null = null;
  if (kind === 'slide_clip') {
    const project = getProject(typeof b.projectId === 'string' ? b.projectId : '');
    if (project.sourceType !== 'SLIDESHOW')
      throw new DemoHttpError(409, 'conflict', 'Clips can only be uploaded to a slideshow');
    if (!SLIDE_EDITABLE.has(project.state))
      throw new DemoHttpError(
        409,
        'conflict',
        `Slides cannot be edited while the project is ${project.state}`,
      );
    projectId = project.id;
  }
  const id = newId('upl');
  const upload: DemoUpload = {
    id,
    kind,
    businessId: typeof b.businessId === 'string' ? b.businessId : null,
    state: 'PENDING',
    fileName,
    contentType,
    sizeBytes: null,
    declaredBytes: size,
    durationSec: null,
    width: null,
    height: null,
    projectId,
    assetId: null,
    errorReason: null,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    received: false,
  };
  uploads.set(id, upload);
  return {
    status: 201,
    body: {
      upload: {
        ...present(upload),
        putUrl: `/api/studio/demo-upload/${id}`,
        maxBytes: MAX_BYTES[kind],
        headers: { 'content-type': contentType },
      },
    },
  };
});

// Stands in for the S3 presigned PUT.
route('PUT', '/demo-upload/:id', ({ params }) => {
  const upload = uploads.get(params.id ?? '');
  if (!upload) throw new DemoHttpError(403, 'forbidden', 'Signature does not match');
  upload.received = true;
  return { stored: true };
});

route('POST', '/uploads/:id/complete', ({ params }) => {
  const brand = completeBrandUpload(params.id ?? '');
  if (brand) return brand;
  const upload = uploads.get(params.id ?? '');
  if (!upload) throw new DemoHttpError(404, 'not_found', 'Upload not found');
  if (upload.state === 'FAILED')
    throw new DemoHttpError(409, 'conflict', `This upload was rejected: ${upload.errorReason}`);
  if (!upload.received) throw bad('The file has not been uploaded yet');
  if (upload.state !== 'READY') {
    // Sample probe: a portrait clip; slide clips are shorter.
    upload.durationSec = upload.kind === 'slide_clip' ? 6.4 : 41.2;
    upload.width = 1080;
    upload.height = 1920;
    upload.sizeBytes = upload.declaredBytes;
    upload.state = 'READY';
    upload.completedAt = new Date().toISOString();
    if (upload.kind === 'slide_clip') upload.assetId = newId('ast');
  }
  return {
    upload: present(upload),
    asset: upload.assetId
      ? {
          id: upload.assetId,
          durationSec: upload.durationSec,
          width: upload.width,
          height: upload.height,
        }
      : null,
  };
});

/** POST /projects { sourceType: UPLOAD, uploadId }: a READY source video, used once. */
export function claimUpload(uploadId: string | undefined): DemoUpload {
  if (!uploadId) throw bad('uploadId is required for UPLOAD projects');
  const upload = uploads.get(uploadId);
  if (!upload || upload.kind !== 'source_video')
    throw bad('uploadId is not an uploaded source video');
  if (upload.state !== 'READY')
    throw bad('The upload is not complete (POST /uploads/:id/complete first)');
  if (upload.projectId)
    throw new DemoHttpError(409, 'conflict', 'This upload is already used by a project');
  upload.assetId = newId('ast');
  return upload;
}

/** 22.1: the business's READY demo videos, newest first (GET /uploads/demo-videos). */
export function demoVideos(businessId: string | null) {
  return [...uploads.values()]
    .filter((u) => u.kind === 'demo_video' && u.state === 'READY' && u.businessId === businessId)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .map(present);
}

/** 22.1: a seeded demo video, so Create → Hook + demo works before anything is uploaded. */
export function seedDemoVideo(businessId: string): void {
  const id = 'upl-demo-order-ahead';
  if (uploads.has(id)) return;
  uploads.set(id, {
    id,
    kind: 'demo_video',
    businessId,
    completedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    state: 'READY',
    fileName: 'order-ahead-app-demo.mp4',
    contentType: 'video/mp4',
    sizeBytes: 18_400_000,
    declaredBytes: 18_400_000,
    durationSec: 34,
    width: 1080,
    height: 1920,
    projectId: null,
    assetId: null,
    errorReason: null,
    expiresAt: new Date().toISOString(),
    received: true,
  });
}

/** The demo pipeline's "plan" for an UPLOAD project: one USER_UPLOAD shot, captions from speech. */
export function uploadContent(p: ProjectRec): ProjectContent {
  const meta = obj(p.metadata?.upload);
  const duration = typeof meta.durationSec === 'number' ? meta.durationSec : 30;
  const longest = Math.max(...p.targetFormats.map((f) => f.duration), 1);
  return {
    scene: 'storefront',
    brief: null,
    shots: [
      {
        treatment: 'USER_UPLOAD',
        durationSec: Math.min(duration, longest),
        kind: 'storefront',
        scene: `Uploaded video: ${String(meta.fileName ?? 'your video')}`,
        camera: null,
        voiceover: null,
        onScreen: 'Welcome to Leeds Sourdough — we bake from 5am.',
      },
    ],
  };
}
