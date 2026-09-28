// Phase 15 Track C sample handlers.
// POST /voice-profiles/:id/consent-check (15.C7) — shape of
// src/app/api/studio/voice-profiles/[id]/consent-check/route.ts. The demo has no transcriber, so
// it answers the documented 409 for a profile that is not PENDING_REVIEW (every seeded profile
// has passed its check) and 404 for an unknown one; it never pretends to transcribe audio.
import { DemoHttpError, route } from '../registry';

route('POST', '/voice-profiles/:id/consent-check', ({ params }) => {
  if (params.id !== 'vp-amara-owner')
    throw new DemoHttpError(404, 'not_found', 'Voice profile not found');
  throw new DemoHttpError(
    409,
    'conflict',
    'Voice profile is READY; only PENDING_REVIEW can be re-checked',
  );
});
