import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { auditQuery, listAuditLog } from '@/lib/studio/services/org-audit';

// GET /api/studio/audit (Phase 18 §2.6 /settings/audit) — the caller's organisation's audit log,
// newest first, cursor-paginated. Owners and admins (studio:audit:read). Always scoped to the
// caller's own organisation; there is no organisation parameter.
export const GET = withStudioRoute(StudioCapability.AuditRead, async ({ req, deps, tenant }) => ({
  body: await listAuditLog(deps.db, tenant.organisationId, parseQuery(req, auditQuery)),
}));
