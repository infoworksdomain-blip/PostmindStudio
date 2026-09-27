import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { updateScript, updateScriptInput } from '@/lib/studio/services/scripts';
import { getScript } from '@/lib/studio/services/shots';

// GET /api/studio/scripts/:id — one script with all shots
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { script: await getScript(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

// PATCH /api/studio/scripts/:id — edit the voiceover and per-shot text (13.1, spec 8.3).
// Changed narration regenerates those shots' voice only; current renders are marked stale.
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const input = await parseBody(req, updateScriptInput);
    const result = await updateScript(deps, tenant, id, input);
    audit(
      'studio.script.update',
      { type: 'video_script', id },
      {
        fullText: input.fullText !== undefined,
        shotIds: (input.shots ?? []).map((s) => s.id),
        voiceRegenerated: result.voiceRegenerated,
        runId: result.runId,
        staleRenders: result.staleRenders,
      },
    );
    return { body: result };
  },
);
