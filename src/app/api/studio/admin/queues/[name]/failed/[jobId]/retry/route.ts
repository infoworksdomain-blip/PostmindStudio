import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  findQueue,
  resolveDeadLetterQueues,
  retryFailed,
  retryInput,
} from '@/lib/studio/services/dead-letter';

// POST /api/studio/admin/queues/:name/failed/:jobId/retry { reason? } — BACKLOG 15.D4: move one
// dead-lettered job back to waiting with its attempts reset (the same job and data). `advisory`
// says when the worker will skip it (older run, project no longer in the pipeline). Staff only;
// studio:admin:redrive because a retry spends provider money for another organisation. Audited.
export const POST = withStudioRoute(
  StudioCapability.AdminRedrive,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, retryInput);
    const queue = findQueue(resolveDeadLetterQueues(deps.deadLetterQueues), params.name ?? '');
    const result = await retryFailed({ db: deps.db, jobs: deps.queue }, queue, params.jobId ?? '');
    audit(
      'studio.dead_letter.retry',
      { type: 'queue_job', id: `${queue.name}/${result.job.id}` },
      { queue: queue.name, jobName: result.job.name, reason: input.reason ?? null },
    );
    return { body: { ...result } };
  },
);
