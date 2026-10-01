import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { dripQueueInput, getDripQueue, putDripQueue } from '@/lib/studio/services/drip-queue';

// 15.A5 — the business's drip queue (spec 3.1 "drip queue"; 9.9 stagger).
// GET /api/studio/businesses/:id/drip-queue → 200 { dripQueue: {…} | null }
// PUT /api/studio/businesses/:id/drip-queue { slots?: [{ weekday 0-6, time "HH:MM", timezone }],
//     schedule?: { mode daily | weekly | custom, timezone, postsPerDay, postsPerWeek, days,
//     timesMode, times, intervalBy, intervalStart, intervalMinutes, windowStart, windowEnd },
//     platforms?: [], enabled? } → 200 { dripQueue: { slots, schedule, platforms, enabled,
//     staggerMinutes, nextSlotAt, queued, upcoming[] } }. 20.14: a daily/weekly schedule is
//     resolved to slots here (posting-schedule.ts); without one the slots are stored as a custom
//     schedule. ≤ 28 slots, ≤ 4 a day. Deciding when posts go live needs publication:write.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      dripQueue: await getDripQueue(
        deps.db,
        { organisationId: tenant.organisationId, businessId: parseBusinessId(params.id) },
        deps.now(),
      ),
    },
  }),
);

export const PUT = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, dripQueueInput);
    const dripQueue = await putDripQueue(deps.db, tenant, businessId, input, deps.now());
    audit(
      'studio.drip_queue.update',
      { type: 'business', id: businessId },
      {
        slots: input.slots.length,
        mode: input.schedule.mode,
        timesMode: input.schedule.mode === 'custom' ? null : input.schedule.timesMode,
        platforms: input.platforms,
        enabled: input.enabled,
      },
    );
    return { body: { dripQueue } };
  },
);
