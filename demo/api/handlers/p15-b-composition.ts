// Phase 15 Track B demo: brand-kit media uploads (15.B1: kinds brand_logo / brand_watermark /
// brand_card / brand_font, with the A11.5 font licence confirmation) and the upload's own PUT
// target. POST /uploads and /uploads/:id/complete in p13-a1-uploads.ts hand brand kinds to the
// functions below (the demo router has no fall-through). Same response shapes as
// services/uploads.ts + services/brand-uploads.ts. The demo cannot read the bytes, so the checks
// the real service makes on them (PNG transparency, the font's family name) use sample values.
import { DemoHttpError, route } from '../registry';
import { newId } from './projects-store';

type Body = Record<string, unknown>;
const bad = (m: string) => new DemoHttpError(400, 'validation_error', m);

const KINDS: Record<string, readonly string[]> = {
  brand_logo: ['image/png'],
  brand_watermark: ['image/png'],
  brand_card: ['image/png', 'image/jpeg', 'video/mp4'],
  brand_font: ['font/ttf', 'font/otf'],
};
const MAX_BYTES: Record<string, number> = {
  brand_logo: 10_485_760,
  brand_watermark: 10_485_760,
  brand_card: 104_857_600,
  brand_font: 10_485_760,
};

interface BrandUpload {
  id: string;
  kind: string;
  state: 'PENDING' | 'READY';
  fileName: string;
  contentType: string;
  sizeBytes: number | null;
  declaredBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fontFamily: string | null;
  licenceConfirmedAt: string | null;
  expiresAt: string;
  received: boolean;
}

const brandUploads = new Map<string, BrandUpload>();

function present(u: BrandUpload) {
  const { declaredBytes: _d, received: _r, ...row } = u;
  return { ...row, projectId: null, assetId: null, errorReason: null };
}

export function isBrandUploadRequest(b: Body): boolean {
  return typeof b.kind === 'string' && b.kind in KINDS;
}

export function createBrandUpload(b: Body) {
  const kind = String(b.kind);
  const contentType = typeof b.contentType === 'string' ? b.contentType : '';
  if (!KINDS[kind]?.includes(contentType))
    throw bad(`${kind} accepts ${(KINDS[kind] ?? []).join(', ')}`);
  if (typeof b.businessId !== 'string' || !b.businessId)
    throw bad('businessId is required for brand-kit media');
  if (kind === 'brand_font' && b.licenceConfirmed !== true)
    throw bad('Confirm that the font licence allows commercial embedding (licenceConfirmed: true)');
  const size = typeof b.sizeBytes === 'number' ? b.sizeBytes : 0;
  if (!(size > 0)) throw bad('sizeBytes is required');
  if (size > (MAX_BYTES[kind] ?? 0))
    throw new DemoHttpError(413, 'payload_too_large', 'Files can be at most 10 MB');
  const fileName = typeof b.fileName === 'string' ? b.fileName.trim().slice(0, 200) : 'file';
  const id = newId('upl');
  const upload: BrandUpload = {
    id,
    kind,
    state: 'PENDING',
    fileName,
    contentType,
    sizeBytes: null,
    declaredBytes: size,
    durationSec: null,
    width: null,
    height: null,
    fontFamily: null,
    licenceConfirmedAt: kind === 'brand_font' ? new Date().toISOString() : null,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    received: false,
  };
  brandUploads.set(id, upload);
  return {
    status: 201,
    body: {
      upload: {
        ...present(upload),
        putUrl: `/api/studio/demo-brand-upload/${id}`,
        maxBytes: MAX_BYTES[kind],
        headers: { 'content-type': contentType },
      },
    },
  };
}

/** POST /uploads/:id/complete for a brand upload; undefined when the id is not one. */
export function completeBrandUpload(id: string) {
  const upload = brandUploads.get(id);
  if (!upload) return undefined;
  if (!upload.received) throw bad('The file has not been uploaded yet');
  if (upload.state !== 'READY') {
    upload.state = 'READY';
    upload.sizeBytes = upload.declaredBytes;
    if (upload.kind === 'brand_font') {
      upload.fontFamily =
        upload.fileName
          .replace(/\.(ttf|otf)$/i, '')
          .replace(/[^A-Za-z0-9 -]/g, ' ')
          .trim() || 'Brand Font';
    } else if (upload.contentType === 'video/mp4') {
      Object.assign(upload, { width: 1080, height: 1920, durationSec: 3.2 });
    } else {
      Object.assign(upload, { width: 800, height: 400 });
    }
  }
  return { upload: present(upload), asset: null };
}

/** Brand upload ids known to the demo (brand-kit PATCH checks kinds against them). */
export function brandUploadKind(id: string): string | undefined {
  const u = brandUploads.get(id);
  return u?.state === 'READY' ? u.kind : undefined;
}

// Stands in for the S3 presigned PUT of a brand file.
route('PUT', '/demo-brand-upload/:id', ({ params }) => {
  const upload = brandUploads.get(params.id ?? '');
  if (!upload) throw new DemoHttpError(403, 'forbidden', 'Signature does not match');
  upload.received = true;
  return { stored: true };
});
