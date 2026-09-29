import { Prisma, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Messages } from '../../i18n/messages';
import { NotImplementedError } from '../../errors';
import type { JobQueue } from '../queue/enqueue';
import {
  createEmailSender,
  emailSenderFromEnv,
  type EmailMessage,
  type EmailPreferenceLookup,
  type EmailSender,
  type EmailStatus,
} from './email';
import { bestEffort, notificationSenderFromEnv, type NotificationSender } from './sender';
import { createPreferenceLookup, type PreferenceLookup } from './preference-lookup';

// Spec 14.4 — in-app notifications (studio.notifications) plus the optional outbound webhook.
// Email (BACKLOG 13.33, Phase 18 §2.8, email.ts): for users who enabled email for the kind, the
// notifier hands the notification to the configured EmailSender and records
// notifications.emailStatus: "sent" once the email is queued (Resend outbox), "failed" when that
// fails, "pending_setup" with no sender (core mode without a Core email API). Every notification
// is stored first; the webhook and email are best effort.

export const NOTIFICATION_KINDS = [
  'cost_alert',
  'cost_paused',
  'publication_failed',
  'generation_complete',
  'approval_pending',
  // Phase 13 (A3): 13.17 content-safety review, 13.21 auto-publish gave up, 13.23 milestones.
  'safety_review',
  'auto_publish_failed',
  'milestone',
  // Phase 15 (15.E5, decision P8): an external reviewer left feedback on a share link.
  'share_comment',
  // Phase 15 (decision P3): 80 % / 100 % of the plan's monthly video quota (services/plan-quotas.ts).
  'plan_quota',
  // Phase 17 (17.3): the daily account-status check found a connection the platform refuses.
  'connection_needs_reconnect',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** BACKLOG 16.5: a key under the `notifications` catalogue namespace (messages/<locale>.json). */
export type NotificationMessageKey = keyof Messages['notifications'];

/**
 * The localisable form of a notification: the app renders notifications.<key>.title/body with
 * these ICU parameters in the reader's locale. `platform` holds the platform id (the app shows
 * its label). title/body stay the English text for email, the webhook and older rows.
 */
export interface NotificationMessage {
  key: NotificationMessageKey;
  params?: Record<string, string | number>;
}

export interface NotificationInput {
  organisationId: string;
  /** null / undefined = every member of the organisation. */
  userId?: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
  /** Notify at most once per (organisation, dedupeKey). */
  dedupeKey?: string;
  /** 16.5: rendered in the reader's locale when present. */
  message?: NotificationMessage;
}

export type StaffNotificationInput = Omit<NotificationInput, 'organisationId' | 'userId'>;

export interface Notifier {
  /** Store (and send) one notification. created=false when the dedupeKey already exists. */
  notify(
    input: NotificationInput,
  ): Promise<{ created: boolean; id?: string; emailStatus?: EmailStatus }>;
  /** PostMind staff: one org-wide row per STUDIO_PLATFORM_ORG_IDS organisation, plus the webhook. */
  notifyStaff(input: StaffNotificationInput): Promise<number>;
}

type NotificationClient = Pick<PrismaClient, 'notification'>;

interface StoredRow {
  id: string;
  organisationId: string;
  userId: string | null;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  messageKey?: string | null;
  messageParams?: Prisma.JsonValue | null;
}

/** 16.5: the row's keyed form for email (params are flat ICU values). */
function keyedMessage(row: StoredRow): EmailMessage['message'] {
  const params = row.messageParams;
  if (!row.messageKey) return undefined;
  const flat: Record<string, string | number> = {};
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'string' || typeof value === 'number') flat[name] = value;
    }
  }
  return { key: row.messageKey, params: flat };
}

const TITLE_MAX = 200;
const BODY_MAX = 2_000;

export function staffOrganisationIds(env: Record<string, string | undefined> = process.env) {
  return (env.STUDIO_PLATFORM_ORG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function createNotifier(deps: {
  db: NotificationClient;
  logger: Logger;
  sender?: NotificationSender;
  staffOrgIds?: () => string[];
  /** Who opted in to email per kind (notification preferences, 13.24). Absent = no email. */
  emailPreferences?: EmailPreferenceLookup;
  /** 13.24: users' in-app choices; a kind turned off in-app is not stored for that user. */
  preferences?: Pick<PreferenceLookup, 'inAppEnabled' | 'emailRecipients'>;
  /** null = no email sender; undefined = from STUDIO_EMAIL_PROVIDER. */
  email?: EmailSender | null;
  appUrl?: string;
}): Notifier {
  const sender = bestEffort(deps.sender ?? notificationSenderFromEnv(), deps.logger);
  const staffOrgIds = deps.staffOrgIds ?? (() => staffOrganisationIds());
  const emailSender = deps.email === undefined ? emailSenderFromEnv() : deps.email;
  const appUrl = (deps.appUrl ?? process.env.APP_URL)?.trim().replace(/\/+$/, '') || undefined;

  async function sendEmail(row: StoredRow, recipientUserIds: string[]): Promise<EmailStatus> {
    if (!emailSender) return 'pending_setup';
    try {
      await emailSender.send({
        notificationId: row.id,
        organisationId: row.organisationId,
        recipientUserIds,
        kind: row.kind as NotificationKind,
        subject: row.title,
        text: row.body,
        link: row.link && appUrl ? `${appUrl}${row.link}` : row.link,
        ...(row.messageKey && { message: keyedMessage(row) }),
      });
      return 'sent';
    } catch (err) {
      if (err instanceof NotImplementedError) return 'pending_setup';
      deps.logger.error({ err, notificationId: row.id }, 'notification email failed');
      return 'failed';
    }
  }

  /** Email for opted-in users; never throws (the in-app row is the record). */
  async function deliverEmail(row: StoredRow): Promise<EmailStatus | undefined> {
    if (!deps.emailPreferences) return undefined;
    try {
      const recipients = await deps.emailPreferences.emailRecipients({
        organisationId: row.organisationId,
        userId: row.userId,
        kind: row.kind as NotificationKind,
      });
      if (recipients.length === 0) return undefined;
      const emailStatus = await sendEmail(row, recipients);
      await deps.db.notification.update({ where: { id: row.id }, data: { emailStatus } });
      if (emailStatus === 'pending_setup') {
        deps.logger.info(
          { notificationId: row.id, kind: row.kind, recipients: recipients.length },
          'notification email pending setup',
        );
      }
      return emailStatus;
    } catch (err) {
      deps.logger.error({ err, notificationId: row.id }, 'notification email step failed');
      return undefined;
    }
  }

  /** 13.24: the target user turned this kind off in-app and did not ask for its email. */
  async function suppressed(input: NotificationInput): Promise<boolean> {
    const prefs = deps.preferences;
    if (!prefs || !input.userId) return false;
    try {
      const target = { organisationId: input.organisationId, userId: input.userId };
      if (await prefs.inAppEnabled({ ...target, kind: input.kind })) return false;
      const email = await prefs.emailRecipients({ ...target, kind: input.kind });
      return email.length === 0;
    } catch (err) {
      // Preferences are a filter: when they cannot be read, deliver rather than drop.
      deps.logger.warn({ err, kind: input.kind }, 'notification preferences unavailable');
      return false;
    }
  }

  async function store(input: NotificationInput) {
    const data = {
      organisationId: input.organisationId,
      userId: input.userId ?? null,
      kind: input.kind,
      title: input.title.slice(0, TITLE_MAX),
      body: input.body.slice(0, BODY_MAX),
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
      messageKey: input.message?.key ?? null,
      messageParams: input.message?.params ?? Prisma.DbNull,
    };
    if (!input.dedupeKey) return deps.db.notification.create({ data });
    try {
      // INSERT … ON CONFLICT DO NOTHING: a duplicate returns no row instead of an error.
      const [row] = await deps.db.notification.createManyAndReturn({
        data: [data],
        skipDuplicates: true,
      });
      return row ?? null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  return {
    async notify(input) {
      if (await suppressed(input)) return { created: false };
      const row = await store(input);
      if (!row) return { created: false };
      await sender.send({ ...row, audience: 'organisation' });
      const emailStatus = await deliverEmail(row);
      return { created: true, id: row.id, ...(emailStatus && { emailStatus }) };
    },
    async notifyStaff(input) {
      const orgs = staffOrgIds();
      let created = 0;
      let first: { id: string; createdAt: Date } | undefined;
      for (const organisationId of orgs) {
        const row = await store({ ...input, organisationId, userId: null });
        if (row) {
          created += 1;
          first ??= row;
        }
      }
      if (orgs.length === 0) {
        deps.logger.warn(
          { kind: input.kind, title: input.title },
          'staff notification has no in-app recipient: STUDIO_PLATFORM_ORG_IDS is not set',
        );
      }
      // One webhook delivery per staff event (not one per staff organisation).
      if (first || orgs.length === 0) {
        await sender.send({
          id: first?.id ?? `staff:${input.dedupeKey ?? input.kind}`,
          audience: 'staff',
          organisationId: null,
          userId: null,
          kind: input.kind,
          title: input.title.slice(0, TITLE_MAX),
          body: input.body.slice(0, BODY_MAX),
          link: input.link ?? null,
          createdAt: first?.createdAt ?? new Date(),
        });
      }
      return created;
    },
  };
}

type NotifierHost = { db: PrismaClient; logger: Logger; notifier?: Notifier; queue?: JobQueue };

const notifiers = new WeakMap<object, Notifier>();

/** The host's injected notifier, or one built from its db/logger and env (memoised per host). */
export function notifierFor(host: NotifierHost): Notifier {
  if (host.notifier) return host.notifier;
  let notifier = notifiers.get(host);
  if (!notifier) {
    const preferences = createPreferenceLookup(host.db);
    notifier = createNotifier({
      db: host.db,
      logger: host.logger,
      preferences,
      emailPreferences: preferences,
      // Phase 18 §2.8: Resend in standalone mode (outbox + send-email job), per STUDIO_EMAIL_PROVIDER.
      email: createEmailSender({ db: host.db, queue: host.queue, logger: host.logger }),
    });
    notifiers.set(host, notifier);
  }
  return notifier;
}

/**
 * Hooks (publication failed, generation complete) must never fail the job they run in: a
 * notification that cannot be stored is logged and dropped.
 */
export async function notifySafely(host: NotifierHost, input: NotificationInput): Promise<void> {
  try {
    await notifierFor(host).notify(input);
  } catch (err) {
    host.logger.error(
      { err, kind: input.kind, organisationId: input.organisationId },
      'notify failed',
    );
  }
}
