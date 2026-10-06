import { StudioCapability } from '@/lib/rbac';
import { readMultipart } from '@/lib/studio/api/multipart';
import { withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import {
  CREATOR_CONSENT_STATEMENT,
  MAX_CREATOR_UPLOAD_BYTES,
  parseCreatorUploadForm,
  uploadCreator,
} from '@/lib/studio/services/creator-upload';
import { present } from '@/lib/studio/services/creators';

// BACKLOG 22.3 — POST /api/studio/businesses/:id/creators/upload (multipart): name, gender,
// ageRange, setting, appearance?, voiceTone?, consent=true and photo (PNG/JPEG ≤ 10 MB). A creator
// from a photo of a real person, only with the uploader's attestation that they have that
// person's consent and the rights; the attestation (who, when, what) is stored and audited.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const form = await readMultipart(req, MAX_CREATOR_UPLOAD_BYTES);
    const input = await parseCreatorUploadForm(form);
    const result = await uploadCreator(
      { db: deps.db, storage: deps.storage, bucket: deps.library.bucket, now: deps.now },
      tenant,
      businessId,
      input,
    );
    audit(
      'studio.creator.create',
      { type: 'creator', id: result.creator.id },
      {
        businessId,
        source: 'UPLOAD',
        status: result.creator.status,
        portraitId: result.creator.portraitId,
        consentAttestedByUserId: tenant.userId,
        consentStatement: CREATOR_CONSENT_STATEMENT,
      },
    );
    return { status: 201, body: { creator: await present(deps, result.creator) } };
  },
);
