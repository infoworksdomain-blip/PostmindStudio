import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { decide, decisionInput } from '@/lib/studio/services/blitz';

// POST /api/studio/blitz/suggestions/:id/decision (22.4) — one swipe.
//   { action: 'skip', reason? }            the card goes; a reason nudges the mix (bounded)
//   { action: 'keep', mode? }              schedule (next free slot, default) | post_now | edit
// A keep reserves the allowance like Create's generate (403 quota_exceeded → upgrade / pack);
// scheduling and posting need studio:project:approve + studio:publication:write as well.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, decisionInput);
    const result = await decide(deps, tenant, params.id ?? '', input);
    if (input.action === 'skip')
      audit(
        'studio.blitz.skip',
        { type: 'blitz_suggestion', id: result.suggestionId },
        input.reason ? { reason: input.reason } : undefined,
      );
    return { body: { result } };
  },
);
