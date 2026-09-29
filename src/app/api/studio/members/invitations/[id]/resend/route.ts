import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { resendInvitation } from '@/lib/studio/services/members';

// POST /api/studio/members/invitations/:id/resend (Phase 18 §2.4) — send the invite email again
// with a fresh 7-day expiry (Better Auth createInvitation with resend).
export const POST = withStudioRoute(
  StudioCapability.MembersManage,
  async ({ req, deps, tenant, params }) => ({
    body: { invitation: await resendInvitation(deps.db, tenant, req.headers, params.id ?? '') },
  }),
);
