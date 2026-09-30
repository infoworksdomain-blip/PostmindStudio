import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { getUpcomingSlots, upcomingQuery, upcomingWindow } from '@/lib/studio/services/drip-queue';

// 20.3 — month-ahead view of the business's drip queue, for the calendar's open-slot markers and
// its "Next 30 days" summary. Read-only, so it needs what GET …/drip-queue needs.
// GET /api/studio/businesses/:id/drip-queue/upcoming?from&to (ISO; default now → +31 days,
// at most 62 days) → 200 { upcoming: { from, to, configured, enabled, slotsPerWeek, horizonDays,
// scheduled, openSlots: [iso], held: [{ slotAt, projectId }] } }. Scoped to the caller's
// organisation: another organisation's queue for the same business id is never read.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps, params }) => {
    const businessId = parseBusinessId(params.id);
    const now = deps.now();
    const window = upcomingWindow(parseQuery(req, upcomingQuery), now);
    return {
      body: {
        upcoming: await getUpcomingSlots(
          deps.db,
          { organisationId: tenant.organisationId, businessId },
          window,
          now,
        ),
      },
    };
  },
);
