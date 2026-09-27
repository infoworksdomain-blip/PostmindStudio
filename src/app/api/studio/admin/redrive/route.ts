import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { redrive, redriveInput } from '@/lib/studio/services/redrive';

// POST /api/studio/admin/redrive — bulk re-drive of kill-switched or stuck work (Phase 12,
// runbooks/kill-switch.md). Dry run by default. Staff only; its own capability because an
// applied re-drive spends provider money on other organisations' behalf.
export const POST = withStudioRoute(
  StudioCapability.AdminRedrive,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, redriveInput);
    const result = await redrive({ db: deps.db, queue: deps.queue, now: deps.now }, input);
    audit(
      'studio.redrive.run',
      { type: 'redrive', id: input.scope },
      {
        filter: {
          scope: input.scope,
          level: input.level ?? null,
          organisationId: input.organisationId ?? null,
          since: input.since ?? null,
          stuckMinutes: input.scope === 'stuck' ? input.stuckMinutes : null,
          limit: input.limit,
        },
        dryRun: input.dryRun,
        counts: result.counts,
      },
    );
    return { body: { ...result } };
  },
);
