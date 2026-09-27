import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NOTIFICATION_KINDS, type NotificationKind } from './notifier';
import { DEFAULT_PREFERENCE } from './preference-lookup';

export {
  createPreferenceLookup,
  DEFAULT_PREFERENCE,
  type PreferenceLookup,
} from './preference-lookup';

// BACKLOG 13.24 — notification preferences per user and kind (studio.notification_preferences).
// Defaults with no row: in-app on, email off. They are respected in three places:
//   - the notifier does not store a user's own notification for a kind they turned off in-app
//     (unless they asked for its email, which needs the stored row);
//   - GET /notifications hides organisation-wide notifications of kinds the reader turned off;
//   - email (13.33, notifications/email.ts) goes only to users who turned email on for the kind.
// Email preferences are stored now; delivery waits for an email channel (Wave B 13.33), which is
// why the settings UI says "Email: pending setup".

type Db = Pick<PrismaClient, 'notificationPreference'>;

export interface KindPreference {
  inApp: boolean;
  email: boolean;
}

export type PreferenceMap = Record<NotificationKind, KindPreference>;

const kindPatch = z
  .object({ inApp: z.boolean().optional(), email: z.boolean().optional() })
  .strict()
  .refine((v) => v.inApp !== undefined || v.email !== undefined, {
    message: 'Send inApp and/or email',
  });

export const preferencesPatchInput = z
  .partialRecord(z.enum(NOTIFICATION_KINDS), kindPatch)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type PreferencesPatch = z.infer<typeof preferencesPatchInput>;

export interface Reader {
  organisationId: string;
  userId: string;
}

export async function getPreferences(db: Db, reader: Reader): Promise<PreferenceMap> {
  const rows = await db.notificationPreference.findMany({
    where: { organisationId: reader.organisationId, userId: reader.userId },
  });
  return Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      return [kind, row ? { inApp: row.inApp, email: row.email } : { ...DEFAULT_PREFERENCE }];
    }),
  ) as PreferenceMap;
}

export async function updatePreferences(
  db: Db,
  reader: Reader,
  patch: PreferencesPatch,
): Promise<PreferenceMap> {
  for (const [kind, change] of Object.entries(patch)) {
    if (!change) continue;
    await db.notificationPreference.upsert({
      where: {
        organisationId_userId_kind: {
          organisationId: reader.organisationId,
          userId: reader.userId,
          kind,
        },
      },
      create: {
        organisationId: reader.organisationId,
        userId: reader.userId,
        kind,
        inApp: change.inApp ?? DEFAULT_PREFERENCE.inApp,
        email: change.email ?? DEFAULT_PREFERENCE.email,
      },
      update: {
        ...(change.inApp !== undefined && { inApp: change.inApp }),
        ...(change.email !== undefined && { email: change.email }),
      },
    });
  }
  return getPreferences(db, reader);
}

/** Kinds this reader turned off in-app (GET /notifications hides them). */
export async function mutedKinds(db: Db, reader: Reader): Promise<string[]> {
  const rows = await db.notificationPreference.findMany({
    where: { organisationId: reader.organisationId, userId: reader.userId, inApp: false },
    select: { kind: true },
  });
  return rows.map((r) => r.kind);
}
