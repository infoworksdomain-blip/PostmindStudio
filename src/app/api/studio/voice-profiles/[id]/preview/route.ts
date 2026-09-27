import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { previewVoiceInput, previewVoiceProfile } from '@/lib/studio/services/voice-profiles';

// POST /api/studio/voice-profiles/:id/preview { text ≤ 300 chars } — a short sample in the
// cloned voice (ElevenLabs TTS through the provider router; costs are tracked like any TTS).
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params }) => ({
    body: await previewVoiceProfile(
      { db: deps.db, storage: deps.library.storage, providers: deps.library.providers },
      tenant,
      params.id ?? '',
      await parseBody(req, previewVoiceInput),
    ),
  }),
);
