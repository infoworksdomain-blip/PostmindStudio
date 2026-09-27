import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { redisConnectionFromEnv } from '@/lib/studio/queue/redis';
import { bullQueuesFor, queueHealth } from '@/lib/studio/services/admin-health';

// GET /api/studio/admin/queues — BACKLOG 13.16 / spec 16.4 "Queue health": waiting, active,
// failed and delayed jobs per BullMQ queue, and how long the oldest waiting job has waited.
// PostMind staff only. 502 when Redis does not answer within 3 s.
export const GET = withStudioRoute(StudioCapability.AdminProviders, async ({ deps, tenant }) => {
  requirePlatformStaff(tenant);
  const queues = deps.adminQueues?.() ?? bullQueuesFor(redisConnectionFromEnv());
  return { body: { queues: await queueHealth(queues, deps.now()) } };
});
