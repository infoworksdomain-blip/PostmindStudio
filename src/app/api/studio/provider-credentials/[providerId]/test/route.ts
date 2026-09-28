import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { buildAdaptersFromKeys } from '@/lib/studio/providers/default-registry';
import { parseProviderId, testCredential } from '@/lib/studio/services/provider-credentials';

// P1 BYOC. POST /api/studio/provider-credentials/:providerId/test → builds the provider's
// adapter(s) with the stored key and calls healthCheck(); the result is stored
// (lastTestedAt / lastTestResult) and returned as { healthy, reason? }.
export const POST = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ tenant, deps, params, audit }) => {
    const providerId = parseProviderId(params.providerId);
    const result = await testCredential(
      {
        db: deps.db,
        keys: deps.publishing.keys,
        now: deps.now,
        buildAdapters: buildAdaptersFromKeys,
      },
      tenant,
      providerId,
    );
    audit(
      'studio.byoc.key_tested',
      { type: 'provider_credential', id: providerId },
      { healthy: result.healthy },
    );
    return { body: result };
  },
);
