import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { decideSafetyReview, safetyDecisionInput } from '@/lib/studio/services/safety-reviews';

// POST /api/studio/admin/safety-reviews/:id/decision { decision: ALLOW|BLOCK, note } — BACKLOG
// 13.17. ALLOW resumes the paused run; BLOCK fails the project with the note. 409 when the review
// was already decided. PostMind staff with studio:admin:moderation only; audited
// (studio.safety_review.decide) by the service.
export const POST = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, safetyDecisionInput);
    const result = await decideSafetyReview(
      deps,
      { userId: tenant.userId, organisationId: tenant.organisationId },
      params.id ?? '',
      input,
    );
    return {
      body: {
        review: {
          id: result.review.id,
          state: result.review.state,
          decisionNote: result.review.decisionNote,
          decidedAt: result.review.decidedAt,
        },
        project: result.project,
      },
    };
  },
);
