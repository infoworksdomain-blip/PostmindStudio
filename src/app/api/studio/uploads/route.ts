import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { createUpload, createUploadInput } from '@/lib/studio/services/uploads';
import { uploadDepsFromEnv } from '@/lib/studio/uploads/signer';

// POST /api/studio/uploads — a presigned S3 PUT for a source video or a slideshow clip (13.5).
// The browser PUTs the file with the returned headers, then calls /uploads/:id/complete.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, createUploadInput);
    const result = await createUpload(
      { db: deps.db, uploads: deps.uploads ?? uploadDepsFromEnv(), now: deps.now },
      tenant,
      input,
    );
    audit(
      'studio.upload.create',
      { type: 'video_upload', id: result.upload.id },
      {
        kind: input.kind,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        projectId: input.projectId ?? null,
      },
    );
    return { status: 201, body: result };
  },
);
