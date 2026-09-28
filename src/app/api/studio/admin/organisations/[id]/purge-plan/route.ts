import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { planHardDelete } from '@/lib/studio/services/organisation-hard-delete';
import { purgeBucketsFromEnv } from '@/lib/studio/services/purge-storage';

// BACKLOG 14.1 — GET /api/studio/admin/organisations/:id/purge-plan (PostMind staff,
// studio:admin:moderation). Dry run of the hard delete that runs once the purge grace passes:
// the purge record (state, graceUntil, due, tombstone summary once deleted), rows per studio table,
// objects and bytes under orgs/<id>/ per bucket (counting stops at 10,000 per bucket: truncated),
// and how many row-referenced keys sit outside that prefix (never deleted). Read-only; deletes
// nothing. Works before a purge is requested too (purge: null), to size an organisation's data.
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    const plan = await planHardDelete(
      { db: deps.db, storage: deps.storage, now: deps.now, buckets: purgeBucketsFromEnv() },
      params.id ?? '',
    );
    return { body: { plan } };
  },
);
