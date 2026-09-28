import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { presentVoiceProfile, recheckVoiceConsent } from '@/lib/studio/services/voice-profiles';

// 15.C7 — POST /api/studio/voice-profiles/:id/consent-check: transcribe the stored consent
// recording again and match it to the consent statement (spec 10.2). Only PENDING_REVIEW
// profiles (409 otherwise). passed → READY (or REQUIRES_VERIFICATION); audited.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const result = await recheckVoiceConsent(
      {
        db: deps.db,
        storage: deps.storage,
        assetsBucket: deps.library.bucket,
        cloning: deps.voiceCloning,
        providers: deps.library.providers,
        now: deps.now,
      },
      tenant,
      id,
    );
    audit(
      'studio.voice_profile.consent_check',
      { type: 'voice_profile', id },
      {
        consentCheck: result.profile.consentCheck,
        state: result.profile.state,
        similarity: result.similarity,
      },
    );
    return {
      body: {
        voiceProfile: presentVoiceProfile(result.profile),
        similarity: result.similarity,
        ...(result.reason && { reason: result.reason }),
      },
    };
  },
);
