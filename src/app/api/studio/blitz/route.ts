import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { deckQuery, getDeck } from '@/lib/studio/services/blitz';
import { parseBusinessId } from '@/lib/studio/services/businesses';

// GET /api/studio/blitz?businessId= (22.4) — the ready Blitz cards of a business (pre-made ones
// with their rendered slides / video, preview ones with a library still), the swipes left today
// and whether new cards are paused (caps). Tops the deck up in the background when it runs low.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, deckQuery);
  const deck = await getDeck(deps, tenant, parseBusinessId(query.businessId));
  return { body: { deck } };
});
