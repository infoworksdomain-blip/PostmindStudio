import { StudioCapability } from '@/lib/rbac';
import { readMultipart } from '@/lib/studio/api/multipart';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createVoiceProfile,
  listVoiceProfiles,
  listVoiceProfilesQuery,
  MAX_VOICE_UPLOAD_BYTES,
  parseVoiceProfileForm,
  presentVoiceProfile,
} from '@/lib/studio/services/voice-profiles';

// BACKLOG 13.13 — voice profiles (spec 10.2).
// GET  /api/studio/voice-profiles?businessId= — active profiles of the organisation
// POST /api/studio/voice-profiles — multipart: name, businessId?, speakerName, consentStatement,
//      consent=true, consentRecording (audio), samples (1–5 audio files ≤ 10 MB each).
//      Plan-gated (STUDIO_VOICE_CLONE_MIN_TIER, default PLUS); consent audited.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { businessId } = parseQuery(req, listVoiceProfilesQuery);
  const rows = await listVoiceProfiles(deps.db, tenant.organisationId, businessId);
  return { body: { data: rows.map(presentVoiceProfile) } };
});

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const form = await readMultipart(req, MAX_VOICE_UPLOAD_BYTES);
    const input = await parseVoiceProfileForm(form);
    const profile = await createVoiceProfile(
      {
        db: deps.db,
        storage: deps.storage,
        assetsBucket: deps.library.bucket,
        cloning: deps.voiceCloning,
        // 15.C7: the consent recording is transcribed and matched before the clone is usable.
        providers: deps.library.providers,
        now: deps.now,
      },
      tenant,
      input,
    );
    // Spec 13.4: proof of consent is recorded with who gave it, when, and what was said.
    audit(
      'studio.voice_profile.create',
      { type: 'voice_profile', id: profile.id },
      {
        businessId: profile.businessId,
        provider: profile.provider,
        speakerName: profile.speakerName,
        consentStatement: profile.consentStatement,
        consentRecording: profile.consentS3Key,
        sampleCount: profile.sampleCount,
        state: profile.state,
        consentCheck: profile.consentCheck,
      },
    );
    return { status: 201, body: { voiceProfile: presentVoiceProfile(profile) } };
  },
);
