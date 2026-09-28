import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  drainFailed,
  drainInput,
  findQueue,
  resolveDeadLetterQueues,
} from '@/lib/studio/services/dead-letter';

// POST /api/studio/admin/queues/:name/failed/drain { confirm: "<queue name>", reason } — BACKLOG
// 15.D4 / spec 11.5: permanently removes every failed job of one queue. Never automatic: the body
// must repeat the queue name exactly (400 otherwise). Staff only; studio:admin:redrive. Audited
// with the number removed.
export const POST = withStudioRoute(
  StudioCapability.AdminRedrive,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, drainInput);
    const queue = findQueue(resolveDeadLetterQueues(deps.deadLetterQueues), params.name ?? '');
    const result = await drainFailed(queue, input);
    audit(
      'studio.dead_letter.drain',
      { type: 'queue', id: queue.name },
      { reason: input.reason, removed: result.removed },
    );
    return { body: { ...result } };
  },
);
