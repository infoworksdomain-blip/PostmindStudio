import { parseInternalBody, withInternalRoute } from '@/lib/studio/api/internal';
import {
  assertRefreshed,
  refreshedTokensInput,
  storeRefreshedToken,
  type RefreshResult,
} from '@/lib/studio/services/meta-channels';

// Internal (X-Service-Token; bind to private ingress) — Engagement 14.13 / 9.6.
// POST /api/studio/internal/tokens/refreshed — PostMind Core's nightly refresh job pushes the
// refreshed Meta tokens. Body: one { organisationId, platform, platformAccountId, accessToken,
// tokenExpiresAt?, scopes? } (404 unregistered, 409 disconnected) or { channels: [...≤100] }
// (200 with a per-channel result: updated | not_found | revoked).
export const POST = withInternalRoute(async ({ req, deps, audit }) => {
  const input = await parseInternalBody(req, refreshedTokensInput);
  const items = 'channels' in input ? input.channels : [input];
  const results: RefreshResult[] = [];
  for (const item of items) {
    const result = await storeRefreshedToken({ db: deps.db, keys: deps.publishing.keys }, item);
    results.push(result);
    if (result.result === 'updated' && result.id)
      audit(
        result.organisationId,
        'studio.connection.meta_token_refreshed',
        { type: 'platform_connection', id: result.id },
        { platform: result.platform, platformAccountId: result.platformAccountId },
      );
  }
  if (!('channels' in input)) {
    const [only] = results as [RefreshResult];
    assertRefreshed(only);
    return { body: { result: only } };
  }
  return { body: { results } };
});
