import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  findQueue,
  listFailed,
  listFailedQuery,
  resolveDeadLetterQueues,
} from '@/lib/studio/services/dead-letter';

// GET /api/studio/admin/queues/:name/failed?cursor=&limit= — BACKLOG 15.D4 / spec 11.5
// dead-letter view: failed jobs newest first, with the job data (secrets and URL query strings
// redacted), failure reason, attempts and timestamps. PostMind staff only; 404 for an unknown
// queue; 502 when Redis does not answer. Inspecting other organisations' jobs is audited.
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const query = parseQuery(req, listFailedQuery);
    const queue = findQueue(resolveDeadLetterQueues(deps.deadLetterQueues), params.name ?? '');
    const page = await listFailed(queue, query);
    audit(
      'studio.dead_letter.inspect',
      { type: 'queue', id: queue.name },
      { cursor: query.cursor ?? null, returned: page.jobs.length, total: page.total },
    );
    return { body: { ...page } };
  },
);
