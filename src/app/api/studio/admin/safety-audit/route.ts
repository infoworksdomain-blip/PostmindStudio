import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listSafetyAudit, listSafetyAuditQuery } from '@/lib/studio/services/safety-audit';

// BACKLOG 14.11 — Trust & Safety monthly audit queue (Admin → Safety audit).
// GET /api/studio/admin/safety-audit?period=YYYY-MM&result=pending|pass|miss&limit&cursor
// (period defaults to last month) → { summary (incl. missRate = "safety miss rate"),
// periods, data (with a signed preview of each render), hasMore, nextCursor }.
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    return { body: await listSafetyAudit(deps, parseQuery(req, listSafetyAuditQuery)) };
  },
);
