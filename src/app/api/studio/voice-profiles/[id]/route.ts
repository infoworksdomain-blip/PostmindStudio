import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { deleteVoiceProfile } from '@/lib/studio/services/voice-profiles';

// DELETE /api/studio/voice-profiles/:id — revokes the voice at ElevenLabs, unlinks it from
// brand kits (narration falls back to the default voice); the consent record is kept.
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const { profile, brandKitsUnlinked } = await deleteVoiceProfile(
      {
        db: deps.db,
        storage: deps.storage,
        assetsBucket: deps.library.bucket,
        cloning: deps.voiceCloning,
        now: deps.now,
      },
      tenant,
      params.id ?? '',
    );
    audit(
      'studio.voice_profile.delete',
      { type: 'voice_profile', id: profile.id },
      { provider: profile.provider, brandKitsUnlinked },
    );
    return { body: { deleted: true, brandKitsUnlinked } };
  },
);
