import { auditLogDurable } from '@/lib/audit';
import { AuditAction } from '@/lib/audit-sink';
import { revokeUserSession } from '@/lib/auth/account-sessions';
import { withSignedInRoute } from '@/lib/auth/session-route';
import { prisma } from '@/lib/prisma';

// Phase 18 Track A — DELETE /api/studio/account/sessions/:id: revoke one of my sessions. Other
// devices notice within the 60 s cookie cache.

export const DELETE = withSignedInRoute(async ({ session, params }) => {
  await revokeUserSession(prisma, session.user.id, params.id ?? '');
  await auditLogDurable({
    actorUserId: session.user.id,
    action: AuditAction.SessionRevoked,
    resource: { type: 'session', id: params.id ?? '' },
    metadata: { scope: 'one' },
  });
  return { body: { revoked: true } };
});
