import type { PrismaClient } from '@prisma/client';
import type { EmailPreferenceLookup } from './email';
import type { NotificationKind } from './notifier';

// BACKLOG 13.24 — the notifier's view of notification preferences (preferences.ts has the API
// side). Kept free of runtime imports from notifier.ts so the notifier can use it without an
// import cycle.

type Db = Pick<PrismaClient, 'notificationPreference'>;

export const DEFAULT_PREFERENCE = { inApp: true, email: false } as const;

export interface PreferenceLookup extends EmailPreferenceLookup {
  /** False when the user turned this kind off in-app. */
  inAppEnabled(input: {
    organisationId: string;
    userId: string;
    kind: NotificationKind;
  }): Promise<boolean>;
}

/** Prisma-backed lookup for the notifier (in-app suppression and email recipients). */
export function createPreferenceLookup(db: Db): PreferenceLookup {
  return {
    async inAppEnabled({ organisationId, userId, kind }) {
      const row = await db.notificationPreference.findUnique({
        where: { organisationId_userId_kind: { organisationId, userId, kind } },
        select: { inApp: true },
      });
      return row?.inApp ?? DEFAULT_PREFERENCE.inApp;
    },
    async emailRecipients({ organisationId, userId, kind }) {
      const rows = await db.notificationPreference.findMany({
        where: { organisationId, kind, email: true, ...(userId && { userId }) },
        select: { userId: true },
        take: 1_000,
      });
      return rows.map((r) => r.userId);
    },
  };
}
