import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  parseProviderId,
  revokeCredential,
  setCredential,
  setCredentialInput,
} from '@/lib/studio/services/provider-credentials';

// P1 BYOC. PUT /api/studio/provider-credentials/:providerId { apiKey, secondaryKey? } stores the
// key envelope-encrypted and returns the public shape; DELETE revokes it (key material wiped).
// Audited without key material. 403 feature_disabled / plan_tier outside Enterprise BYOC.
export const PUT = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ req, tenant, deps, params, audit }) => {
    const providerId = parseProviderId(params.providerId);
    const input = await parseBody(req, setCredentialInput);
    const credential = await setCredential(
      { db: deps.db, keys: deps.publishing.keys, now: deps.now },
      tenant,
      providerId,
      input,
    );
    audit(
      'studio.byoc.key_set',
      { type: 'provider_credential', id: providerId },
      { hint: credential.hint },
    );
    return { body: { credential } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ tenant, deps, params, audit }) => {
    const providerId = parseProviderId(params.providerId);
    const credential = await revokeCredential({ db: deps.db }, tenant, providerId);
    audit('studio.byoc.key_revoked', { type: 'provider_credential', id: providerId });
    return { body: { credential } };
  },
);
