import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createTakedownInput,
  createTakedownRequest,
  listTakedownQuery,
  listTakedownRequests,
} from '@/lib/studio/services/transparency';

// BACKLOG 15.E4 — the takedown log behind the transparency report (spec 18.5: policy@postmind.ai
// "receives takedown and regulatory requests"). PostMind staff, studio:admin:moderation.
//   GET  /api/studio/admin/takedown-requests?year=&state=&limit=
//   POST /api/studio/admin/takedown-requests { receivedAt, source, category, summary, … } → 201
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, tenant, deps }) => {
    requirePlatformStaff(tenant);
    const query = parseQuery(req, listTakedownQuery);
    return { body: { data: await listTakedownRequests(deps.db, query) } };
  },
);

export const POST = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, tenant, deps, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, createTakedownInput);
    const request = await createTakedownRequest(deps.db, tenant.userId, input);
    audit(
      'studio.takedown_request.create',
      { type: 'takedown_request', id: request.id },
      { source: request.source, category: request.category, publicationId: request.publicationId },
    );
    return { status: 201, body: { request } };
  },
);
