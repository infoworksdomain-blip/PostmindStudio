import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { feedbackInput, submitFeedback } from '@/lib/studio/services/feedback';

// BACKLOG 14.11 — in-app feedback (the app shell's Feedback button). POST { kind:
// bug|idea|praise|other, message ≤ 2000, projectId?, screen } → 201 { feedback }. Any signed-in
// user of the organisation; 429 (Retry-After) past 10 an hour per user; 404 for a projectId
// outside the organisation. Audited without the message text.
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, deps, tenant, audit }) => {
    const input = await parseBody(req, feedbackInput);
    const feedback = await submitFeedback(
      deps.db,
      { organisationId: tenant.organisationId, userId: tenant.userId },
      input,
      deps.now(),
    );
    audit(
      'studio.feedback.create',
      { type: 'feedback', id: feedback.id },
      { kind: feedback.kind, screen: feedback.screen, projectId: feedback.projectId },
    );
    return { status: 201, body: { feedback } };
  },
);
