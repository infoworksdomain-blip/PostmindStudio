import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { adminPatchInput, adminPatchLibraryVideo } from '@/lib/studio/services/library';

// PATCH /api/studio/admin/library/videos/:id — STAFF ONLY: metadata, category, licence
export const PATCH = withStudioRoute(
  StudioCapability.AdminLibrary,
  async ({ req, deps, params, audit }) => {
    const input = await parseBody(req, adminPatchInput);
    const video = await adminPatchLibraryVideo(deps.db, params.id ?? '', input);
    audit(
      'studio.library.update',
      { type: 'video_library', id: video.id },
      { fields: Object.keys(input) },
    );
    return { body: { video } };
  },
);
