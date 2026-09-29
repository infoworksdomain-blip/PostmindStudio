import { studioModes } from '@/lib/mode';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { selectMetaConnect } from '@/lib/studio/core/select';
import { oauthInitInput, startOAuth } from '@/lib/studio/services/connections';

// POST /api/studio/platform-connections/oauth-init — start OAuth; returns the authorize URL.
// platform 'meta' (Phase 18 §2.10) starts Studio's own Facebook Login for Business: 409 when
// STUDIO_META_CONNECT=core (PostMind settings owns it), 501 until the operator configures the app.
export const POST = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, oauthInitInput);
    const result = await startOAuth(
      {
        oauth: deps.publishing.oauth,
        oauthState: deps.oauthState,
        appUrl: deps.appUrl,
        meta: deps.metaConnect ?? selectMetaConnect(deps.modes ?? studioModes()),
      },
      tenant,
      input,
    );
    audit('studio.connection.oauth_start', { type: 'platform_connection', id: input.platform });
    return { body: result };
  },
);
