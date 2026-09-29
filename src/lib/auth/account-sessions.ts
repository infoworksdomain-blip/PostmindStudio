import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../errors';

// Phase 18 §2.3 / §5.4 — the signed-in user's active sessions, for /account/security. Better
// Auth's own /list-sessions returns every session TOKEN to the browser; Studio lists them without
// tokens and revokes by id, so JavaScript never sees a credential.

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

type Db = Pick<PrismaClient, 'session'>;

export async function listUserSessions(
  db: Db,
  userId: string,
  currentSessionId: string,
  now: Date = new Date(),
): Promise<SessionSummary[]> {
  const rows = await db.session.findMany({
    where: { userId, expiresAt: { gt: now } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
    },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    lastActiveAt: r.updatedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    current: r.id === currentSessionId,
  }));
}

/** Revoke one of the user's own sessions (never someone else's: 404). */
export async function revokeUserSession(db: Db, userId: string, sessionId: string): Promise<void> {
  const { count } = await db.session.deleteMany({ where: { id: sessionId, userId } });
  if (count === 0) throw new NotFoundError('Session not found');
}

/** Revoke every session of the user except the current one; returns how many. */
export async function revokeOtherSessions(
  db: Db,
  userId: string,
  currentSessionId: string,
): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: { userId, id: { not: currentSessionId } },
  });
  return count;
}
