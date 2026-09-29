import { auditLogDurable } from '@/lib/audit';
import { AuditAction } from '@/lib/audit-sink';
import { listUserSessions, revokeOtherSessions } from '@/lib/auth/account-sessions';
import { withSignedInRoute } from '@/lib/auth/session-route';
import { prisma } from '@/lib/prisma';

// Phase 18 Track A — GET: my active sessions (no tokens). DELETE: sign out every other session.

export const GET = withSignedInRoute(async ({ session }) => ({
  body: { sessions: await listUserSessions(prisma, session.user.id, session.session.id) },
}));

export const DELETE = withSignedInRoute(async ({ session }) => {
  const revoked = await revokeOtherSessions(prisma, session.user.id, session.session.id);
  await auditLogDurable({
    actorUserId: session.user.id,
    action: AuditAction.SessionRevoked,
    resource: { type: 'user', id: session.user.id },
    metadata: { scope: 'others', count: revoked },
  });
  return { body: { revoked } };
});
