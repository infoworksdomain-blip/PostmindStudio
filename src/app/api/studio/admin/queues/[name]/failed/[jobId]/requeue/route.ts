import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  findQueue,
  requeueFailed,
  requeueInput,
  resolveDeadLetterQueues,
} from '@/lib/studio/services/dead-letter';

// POST /api/studio/admin/queues/:name/failed/:jobId/requeue { providerId?, reason? } — BACKLOG
// 15.D4 / spec 11.5 "requeue-with-different-provider". providerId (a PROVIDER_IDS entry) is
// accepted for generate-asset jobs only and must be a router candidate for the shot; a failed
// asset stage is resumed under a new run (services/dead-letter-requeue.ts). Other job types are
// removed and added again unchanged. Staff only; studio:admin:redrive. Audited.
export const POST = withStudioRoute(
  StudioCapability.AdminRedrive,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, requeueInput);
    const queue = findQueue(resolveDeadLetterQueues(deps.deadLetterQueues), params.name ?? '');
    const result = await requeueFailed(
      { db: deps.db, jobs: deps.queue },
      queue,
      params.jobId ?? '',
      input,
    );
    audit(
      'studio.dead_letter.requeue',
      { type: 'queue_job', id: `${queue.name}/${result.job.id}` },
      {
        queue: queue.name,
        jobName: result.job.name,
        providerId: input.providerId ?? null,
        reason: input.reason ?? null,
        outcome: result.outcome,
      },
    );
    return { body: { ...result } };
  },
);
