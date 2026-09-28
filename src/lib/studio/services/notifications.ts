import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError } from '../../errors';
import { mutedKinds } from '../notifications/preferences';

// Spec 14.4 in-app notifications behind /api/studio/notifications. A user sees their own
// notifications and the organisation-wide ones (userId null). Read state is per row, so an
// organisation-wide notification marked read is read for every member (no per-user receipts).

type Db = Pick<PrismaClient, 'notification' | 'notificationPreference'>;

export const listNotificationsQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(64).optional(),
});

export interface Reader {
  organisationId: string;
  userId: string;
}

function visibleTo(reader: Reader): Prisma.NotificationWhereInput {
  return {
    organisationId: reader.organisationId,
    OR: [{ userId: reader.userId }, { userId: null }],
  };
}

const PUBLIC_FIELDS = {
  id: true,
  kind: true,
  title: true,
  body: true,
  link: true,
  readAt: true,
  createdAt: true,
  /** 13.33: null | pending_setup | sent | failed. */
  emailStatus: true,
  /** 16.5: catalogue key + ICU params; the app renders them in the reader's locale. */
  messageKey: true,
  messageParams: true,
} as const;

export async function listNotifications(
  db: Db,
  reader: Reader,
  query: z.infer<typeof listNotificationsQuery>,
) {
  // 13.24: kinds the reader turned off in-app are hidden (organisation-wide rows included).
  const muted = await mutedKinds(db, reader);
  const hidden: Prisma.NotificationWhereInput = muted.length ? { kind: { notIn: muted } } : {};
  const where: Prisma.NotificationWhereInput = {
    ...visibleTo(reader),
    ...hidden,
    ...(query.unread === 'true' && { readAt: null }),
    ...(query.unread === 'false' && { readAt: { not: null } }),
  };
  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      select: PUBLIC_FIELDS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    }),
    db.notification.count({ where: { ...visibleTo(reader), ...hidden, readAt: null } }),
  ]);
  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  return { data, unreadCount, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null, hasMore };
}

export async function markNotificationRead(db: Db, reader: Reader, id: string, now: number) {
  const existing = await db.notification.findFirst({
    where: { id, ...visibleTo(reader) },
    select: { id: true, readAt: true },
  });
  if (!existing) throw new NotFoundError('Notification not found');
  if (!existing.readAt) {
    await db.notification.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date(now) },
    });
  }
  return db.notification.findUniqueOrThrow({ where: { id }, select: PUBLIC_FIELDS });
}

export async function markAllNotificationsRead(db: Db, reader: Reader, now: number) {
  const result = await db.notification.updateMany({
    where: { ...visibleTo(reader), readAt: null },
    data: { readAt: new Date(now) },
  });
  return { updated: result.count };
}
