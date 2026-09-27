import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { oauthInitInput, startOAuth } from '@/lib/studio/services/connections';

// POST /api/studio/platform-connections/oauth-init — start OAuth; returns the authorize URL
export const POST = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, oauthInitInput);
    const result = await startOAuth(
      { oauth: deps.publishing.oauth, oauthState: deps.oauthState, appUrl: deps.appUrl },
      tenant,
      input,
    );
    audit('studio.connection.oauth_start', { type: 'platform_connection', id: input.platform });
    return { body: result };
  },
);
