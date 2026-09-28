import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { ensureRenderSrt, renderCaptions } from '@/lib/studio/overlays/voice-captions';
import { findRender } from '@/lib/studio/services/renders';

// GET /api/studio/renders/:id/captions (15.A4; spec 3.1 captions, 5.8 "YouTube gets uploaded as
// SRT alongside the video") → 200 { mode: burn|srt, language, srtUrl, lines[{startAtSec,
// endAtSec, text}] }. Lines come from the narration's word timings; srtUrl is null when the
// narration was never transcribed. Burned-in platforms show the same lines as editable overlays.
const SRT_URL_TTL_SEC = 60 * 60;

export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const { project: _project, ...render } = await findRender(
      deps.db,
      tenant.organisationId,
      params.id ?? '',
    );
    const stored = await ensureRenderSrt(deps, render, tenant.organisationId);
    const captions =
      stored?.captions ?? (await renderCaptions(deps.db, render, tenant.organisationId));
    return {
      body: {
        renderId: render.id,
        mode: captions.mode,
        language: captions.language,
        srtUrl: stored
          ? await deps.storage.signedUrl(render.s3Bucket, stored.key, SRT_URL_TTL_SEC)
          : null,
        lines: captions.lines,
      },
    };
  },
);
