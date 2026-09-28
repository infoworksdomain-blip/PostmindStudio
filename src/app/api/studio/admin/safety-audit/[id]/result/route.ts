import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { notifierFor } from '@/lib/studio/notifications/notifier';
import { auditResultInput, recordAuditResult } from '@/lib/studio/services/safety-audit';

// BACKLOG 14.11 — record a Trust & Safety audit verdict. POST { result: pass|miss, note? (required
// for a miss) } → { item }. 409 once recorded. A miss notifies PostMind staff and counts towards
// the period's "Hive scan miss rate". Audited (studio.safety_audit.record).
export const POST = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, auditResultInput);
    const item = await recordAuditResult(
      { db: deps.db, notifier: notifierFor(deps), logger: deps.logger, now: deps.now },
      params.id ?? '',
      input,
      tenant.userId,
    );
    audit(
      'studio.safety_audit.record',
      { type: 'safety_audit_item', id: item.id },
      { result: item.result, period: item.period, publicationId: item.publicationId },
    );
    return { body: { item } };
  },
);
