import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { scanWebsiteInput, startScan } from '@/lib/studio/services/scans';

// POST /api/studio/businesses/:id/scan-website — start (or refresh) a website scan (A6.8)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, scanWebsiteInput);
    const scan = await startScan(deps, tenant, businessId, input);
    // A6.7 / A11.2: record the ownership warranty — who gave it, when, and the exact text ticked
    // (also stored on website_scans.ownershipStatement).
    audit(
      'studio.website_scan.start',
      { type: 'website_scan', id: scan.id },
      {
        businessId,
        url: scan.url,
        ownershipConfirmed: true,
        ownershipStatement: scan.ownershipStatement,
      },
    );
    return { status: 202, body: { scanId: scan.id, scan } };
  },
);
