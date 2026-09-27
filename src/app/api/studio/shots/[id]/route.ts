import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  deleteShot,
  isSwapRequest,
  swapShotAsset,
  swapShotAssetInput,
} from '@/lib/studio/services/shot-edits';
import { getShot, updateShot, updateShotInput } from '@/lib/studio/services/shots';

// GET /api/studio/shots/:id — one shot with its assets
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { shot: await getShot(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

async function peekJson(req: Request): Promise<unknown> {
  try {
    return JSON.parse(await req.clone().text()) as unknown;
  } catch {
    return undefined; // parseBody reports the invalid JSON
  }
}

// PATCH /api/studio/shots/:id
//   { voiceoverText?, onScreenText? } — edit narration / caption; regenerates voice only (202)
//   { assetId } | { imageLibraryId } — swap the shot's visual (13.2); renders go stale (200)
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    if (isSwapRequest(await peekJson(req))) {
      const input = await parseBody(req, swapShotAssetInput);
      const result = await swapShotAsset(deps.db, tenant.organisationId, id, input);
      audit(
        'studio.shot.swap_asset',
        { type: 'video_shot', id },
        {
          assetId: result.shot.assetId,
          imageLibraryId: input.imageLibraryId ?? null,
          staleRenders: result.staleRenders,
        },
      );
      return { body: result };
    }
    const input = await parseBody(req, updateShotInput);
    const result = await updateShot(deps, tenant, id, input);
    audit(
      'studio.shot.update',
      { type: 'video_shot', id },
      { ...result, fields: Object.keys(input) },
    );
    return { status: 202, body: { shotId: id, ...result } };
  },
);

// DELETE /api/studio/shots/:id — remove the shot and re-time its script (409 on the last shot)
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const result = await deleteShot(deps.db, tenant.organisationId, id);
    audit(
      'studio.shot.delete',
      { type: 'video_shot', id },
      { scriptId: result.script.id, staleRenders: result.staleRenders },
    );
    return { body: result };
  },
);
