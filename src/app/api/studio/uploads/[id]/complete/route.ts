import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { completeUpload } from '@/lib/studio/services/uploads';
import { uploadDepsFromEnv } from '@/lib/studio/uploads/signer';

// POST /api/studio/uploads/:id/complete — check the uploaded file's size, probe it with ffprobe
// and mark it READY (13.5). A slideshow clip also becomes a video asset of its project.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const result = await completeUpload(
      { db: deps.db, uploads: deps.uploads ?? uploadDepsFromEnv(), now: deps.now },
      tenant.organisationId,
      id,
    );
    audit(
      'studio.upload.complete',
      { type: 'video_upload', id },
      {
        durationSec: result.upload.durationSec,
        sizeBytes: result.upload.sizeBytes,
        assetId: result.asset?.id ?? null,
      },
    );
    return { body: result };
  },
);
