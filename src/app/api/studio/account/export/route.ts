import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { jobIds } from '@/lib/studio/queue/enqueue';
import { toPlanTier } from '@/lib/studio/services/catalog';
import {
  failExport,
  listExports,
  requestExport,
  requestExportInput,
} from '@/lib/studio/services/export';

// BACKLOG 15.E1 — right of access (spec 18.4 studio.postmind.ai/account/export; A11.7).
//   GET  /api/studio/account/export → { data: [export] } (the organisation's recent exports)
//   POST /api/studio/account/export { include?: [projects|analytics|brand|image_library] }
//        → 202 { export: { id, state: "QUEUED" } }; 409 while another export is running.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => ({
  body: { data: await listExports(deps.db, tenant.organisationId, deps.now()) },
}));

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const { include } = await parseBody(req, requestExportInput);
    const created = await requestExport(deps.db, tenant, include);
    const data = {
      organisationId: tenant.organisationId,
      runId: created.id,
      exportId: created.id,
      planTier: toPlanTier(tenant.organisation.planTier),
    };
    try {
      await deps.queue.add('export-account-data', data, { jobId: jobIds.exportAccountData(data) });
    } catch (err) {
      // No job will ever run: free the organisation's one-at-a-time slot instead of leaving the
      // export "Queued" (and every later request a 409) forever.
      await failExport(deps.db, created.id, 'The export could not be queued. Try again.');
      throw err;
    }
    audit('studio.account.export', { type: 'data_export', id: created.id }, { include });
    return { status: 202, body: { export: created } };
  },
);
