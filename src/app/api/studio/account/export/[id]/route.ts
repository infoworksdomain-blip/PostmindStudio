import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getExport } from '@/lib/studio/services/export';

// GET /api/studio/account/export/:id — BACKLOG 15.E1: state, and once READY a signed download
// link that expires with the export (7 days after it was made). Downloading is audited.
export const GET = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const exp = await getExport(deps, tenant.organisationId, params.id ?? '');
    if (exp.downloadUrl)
      audit('studio.account.export_download', { type: 'data_export', id: exp.id });
    return { body: { export: exp } };
  },
);
