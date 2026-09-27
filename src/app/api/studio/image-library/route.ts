import { ValidationError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { MAX_IMAGE_BYTES } from '@/lib/studio/images/ingest';
import { listImages, listImagesQuery, uploadImage } from '@/lib/studio/services/image-library';

// GET  /api/studio/image-library — list (?businessId, ?source, ?tag, cursor pagination)
// POST /api/studio/image-library — multipart upload (fields: businessId, file, tags?, altText?)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => ({
  body: await listImages(deps, tenant.organisationId, parseQuery(req, listImagesQuery)),
}));

const MAX_UPLOAD_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    // Refuse oversized or unsized bodies before buffering anything.
    const length = Number(req.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0)
      throw new ValidationError('Content-Length is required for uploads');
    if (length > MAX_UPLOAD_REQUEST_BYTES) throw new ValidationError('Image is larger than 15 MB');
    if (!req.headers.get('content-type')?.startsWith('multipart/form-data'))
      throw new ValidationError('Upload must be multipart/form-data');
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ValidationError('Malformed multipart body');
    }
    const result = await uploadImage(deps.library, tenant, form);
    audit('studio.image_library.upload', { type: 'image_library', id: result.image.id });
    return { status: result.duplicate ? 200 : 201, body: result };
  },
);
