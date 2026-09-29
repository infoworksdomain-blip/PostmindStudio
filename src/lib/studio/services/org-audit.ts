import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';

// Phase 18 §2.6 / §3 /settings/audit — an organisation's audit log (studio.audit_log), newest
// first, keyset-paginated on (occurredAt, id). Always filtered to ONE organisation: the route
// passes the caller's own organisation, and admin passes the one staff are looking at. Rows
// hold ids and codes only (no personal data), so nothing is redacted here.

export const auditQuery = z
  .object({
    /** Action prefix, e.g. "member." or "billing.checkout_started". */
    action: z
      .string()
      .trim()
      .max(64)
      .regex(/^[a-z0-9_.]+$/)
      .optional(),
    actorUserId: z.string().trim().min(1).max(128).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type AuditQuery = z.infer<typeof auditQuery>;

export interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  impersonatorUserId: string | null;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const occurredAt = new Date(iso ?? '');
  if (!id || Number.isNaN(occurredAt.getTime())) throw new ValidationError('Invalid cursor');
  return { occurredAt, id };
}

export async function listAuditLog(
  db: PrismaClient,
  organisationId: string,
  query: AuditQuery,
): Promise<{ data: AuditRow[]; nextCursor: string | null }> {
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const where: Prisma.AuditLogWhereInput = {
    organisationId,
    ...(query.action && { action: { startsWith: query.action } }),
    ...(query.actorUserId && { actorUserId: query.actorUserId }),
    ...(after && {
      OR: [
        { occurredAt: { lt: after.occurredAt } },
        { occurredAt: after.occurredAt, id: { lt: after.id } },
      ],
    }),
  };
  const rows = await db.auditLog.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const actorIds = [...new Set(page.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(actors.map((a) => [a.id, a.name]));
  const last = page.at(-1);
  return {
    data: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      action: r.action,
      actorType: r.actorType,
      actorUserId: r.actorUserId,
      actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null,
      impersonatorUserId: r.impersonatorUserId,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      metadata: r.metadata,
    })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.occurredAt, last.id) : null,
  };
}
