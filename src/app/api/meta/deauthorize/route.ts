import { withMetaCallback } from '@/lib/studio/api/meta-callback';
import { META_ACTOR, revokeForMetaSubject } from '@/lib/studio/services/meta-connect';

// POST /api/meta/deauthorize — Meta's "Deauthorize callback URL" (App Dashboard → Facebook Login
// for Business → Settings). Sent when a user (signed_request user_id) or a Page (profile_id)
// removes Studio's app: every Page / Instagram connection that login created is revoked and its
// tokens wiped, and each is audited as studio.connection.meta_deauthorized. Always 200 once the
// signature verifies (Meta does not retry on a 4xx we would send for "nothing to revoke").
export const dynamic = 'force-dynamic';

export const POST = withMetaCallback('deauthorize', async ({ deps, request, correlationId }) => {
  const revoked = await revokeForMetaSubject(deps.db, request);
  for (const connection of revoked)
    deps.audit({
      actorUserId: META_ACTOR,
      organisationId: connection.organisationId,
      action: 'studio.connection.meta_deauthorized',
      resource: { type: 'platform_connection', id: connection.id },
      metadata: { platform: connection.platform, correlationId },
    });
  deps.logger.info({ correlationId, revoked: revoked.length }, 'meta deauthorize processed');
  return { body: { ok: true } };
});
