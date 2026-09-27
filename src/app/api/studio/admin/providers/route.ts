import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getCircuitBreaker } from '@/lib/studio/providers/circuit-breaker';
import { providerHealth } from '@/lib/studio/services/admin-health';

// GET /api/studio/admin/providers — BACKLOG 13.16 / spec 16.4 "Provider health": per provider
// the shared circuit-breaker state, the error rate of jobs started in the last hour (client-side
// refusals excluded, as for the breaker) and today's spend (UTC). PostMind staff only.
export const GET = withStudioRoute(StudioCapability.AdminProviders, async ({ deps, tenant }) => {
  requirePlatformStaff(tenant);
  const breaker = deps.breaker ?? getCircuitBreaker();
  return {
    body: {
      providers: await providerHealth(
        { db: deps.db, registry: deps.registry, breaker },
        deps.now(),
      ),
    },
  };
});
