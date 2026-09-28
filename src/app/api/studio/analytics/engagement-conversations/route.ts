import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  engagementConversationReport,
  engagementReportQuery,
} from '@/lib/studio/services/conversations';

// GET /api/studio/analytics/engagement-conversations?days=30&businessId= — BACKLOG 15.E3, spec
// 15.4: conversations and inbox leads Engagement attributed to this organisation's publications,
// by project, by script hook and by platform. Empty until Engagement calls attribute-conversation.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, engagementReportQuery);
  return {
    body: {
      report: await engagementConversationReport(deps.db, tenant.organisationId, query, deps.now()),
    },
  };
});
