import { withMetaCallback } from '@/lib/studio/api/meta-callback';
import {
  deleteMetaUserData,
  deletionConfirmationCode,
  deletionStatusUrl,
  META_ACTOR,
} from '@/lib/studio/services/meta-connect';

// POST /api/meta/data-deletion — Meta's "Data Deletion Request URL" (App Dashboard → App settings
// → Basic). https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
// (read 2026-09-29): initiate deletion of the user's data and answer
// { url, confirmation_code } — a status page and an alphanumeric code. Studio revokes the user's
// Page / Instagram connections, wipes their tokens and clears the Meta-derived fields at once, so
// the status page (/meta/data-deletion?code=…) always reports a completed request.
export const dynamic = 'force-dynamic';

export const POST = withMetaCallback(
  'data-deletion',
  async ({ deps, request, appSecret, correlationId }) => {
    const deleted = await deleteMetaUserData(deps.db, request);
    for (const connection of deleted)
      deps.audit({
        actorUserId: META_ACTOR,
        organisationId: connection.organisationId,
        action: 'studio.connection.meta_data_deleted',
        resource: { type: 'platform_connection', id: connection.id },
        metadata: { platform: connection.platform, correlationId },
      });
    const code = deletionConfirmationCode(appSecret, deps.now(), deleted.length);
    deps.logger.info({ correlationId, deleted: deleted.length }, 'meta data deletion processed');
    return { body: { url: deletionStatusUrl(deps.appUrl, code), confirmation_code: code } };
  },
);
