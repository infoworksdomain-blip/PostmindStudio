import { StudioCapability } from '@/lib/rbac';
import { fileField, readMultipart } from '@/lib/studio/api/multipart';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  THUMBNAIL_MAX_BYTES,
  generateRenderThumbnail,
  generateThumbnailInput,
  thumbnailDepsForApi,
  uploadRenderThumbnail,
} from '@/lib/studio/services/thumbnails';
import { ValidationError } from '@/lib/errors';

// POST /api/studio/renders/:id/thumbnail (15.A3; spec 14.2 "thumbnail … editable inline")
//   JSON { source?: keyframe|library|auto, atSec?, overlayText?, imageId? } → regenerate
//     (A6.5: keyframe + hook text, library background weighted by past engagement)
//   multipart/form-data file=<JPEG|PNG ≤ 8 MB> → replace with an upload
// → 200 { render: { id, thumbnailUrl } }. YouTube publishes it with thumbnails.set.
const MULTIPART_OVERHEAD = 64 * 1024;

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const thumbs = thumbnailDepsForApi(deps);
    const id = params.id ?? '';
    const isUpload = req.headers.get('content-type')?.startsWith('multipart/form-data');
    let result: Awaited<ReturnType<typeof uploadRenderThumbnail>>;
    let source: string;
    if (isUpload) {
      const form = await readMultipart(req, THUMBNAIL_MAX_BYTES + MULTIPART_OVERHEAD);
      const file = fileField(form, 'file');
      if (!file) throw new ValidationError('file is required');
      result = await uploadRenderThumbnail(
        thumbs,
        tenant.organisationId,
        id,
        new Uint8Array(await file.arrayBuffer()),
      );
      source = 'upload';
    } else {
      const input = await parseBody(req, generateThumbnailInput);
      result = await generateRenderThumbnail(thumbs, tenant.organisationId, id, input);
      source = input.source;
    }
    audit('studio.render.thumbnail', { type: 'video_render', id: result.render.id }, { source });
    return { body: { render: { id: result.render.id, thumbnailUrl: result.thumbnailUrl } } };
  },
);
