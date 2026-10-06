import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  connectionSettingsInput,
  disconnect,
  updateConnectionSettings,
} from '@/lib/studio/services/connections';

// DELETE /api/studio/platform-connections/:id — disconnect (tokens wiped)
export const DELETE = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await disconnect(deps.db, tenant.organisationId, id);
    audit('studio.connection.disconnect', { type: 'platform_connection', id });
    return { body: { disconnected: true } };
  },
);

// PATCH /api/studio/platform-connections/:id { tiktokPostMode: 'direct' | 'drafts' } — 22.7
export const PATCH = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, connectionSettingsInput);
    const result = await updateConnectionSettings(
      deps.db,
      tenant.organisationId,
      params.id ?? '',
      input,
    );
    audit(
      'studio.connection.settings_update',
      { type: 'platform_connection', id: result.connection.id },
      { tiktokPostMode: input.tiktokPostMode },
    );
    return { body: result };
  },
);
