import { z } from 'zod';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  periodParam,
  previousPeriod,
  safetyAuditSampleFromEnv,
  sampleSafetyAudit,
  SAFETY_AUDIT_SAMPLE_MAX,
} from '@/lib/studio/services/safety-audit';

const sampleInput = z
  .object({
    period: periodParam.optional(),
    sampleSize: z.number().int().min(1).max(SAFETY_AUDIT_SAMPLE_MAX).optional(),
  })
  .strict();

// BACKLOG 14.11 — draw (or top up) a period's audit sample by hand, e.g. the first month or after
// a failed scheduled run. POST { period?: YYYY-MM (default last month), sampleSize? (default
// STUDIO_SAFETY_AUDIT_SAMPLE) } → { sample }. Idempotent. Audited.
export const POST = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, sampleInput);
    const sample = await sampleSafetyAudit(deps.db, {
      period: input.period ?? previousPeriod(deps.now()),
      sampleSize: input.sampleSize ?? safetyAuditSampleFromEnv(),
    });
    audit('studio.safety_audit.sample', { type: 'safety_audit', id: sample.period }, { ...sample });
    return { body: { sample } };
  },
);
