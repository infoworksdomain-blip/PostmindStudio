import { Prisma, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { bestEffort, notificationSenderFromEnv, type NotificationSender } from './sender';

// Spec 14.4 — in-app notifications (studio.notifications) plus the optional outbound webhook.
// Email delivery is not built: no PostMind Core notification/email API is documented (see
// PROGRESS.md). Every notification is stored first; the webhook is best effort.

export const NOTIFICATION_KINDS = [
  'cost_alert',
  'cost_paused',
  'publication_failed',
  'generation_complete',
  'approval_pending',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

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
}

export type StaffNotificationInput = Omit<NotificationInput, 'organisationId' | 'userId'>;

export interface Notifier {
  /** Store (and send) one notification. created=false when the dedupeKey already exists. */
  notify(input: NotificationInput): Promise<{ created: boolean; id?: string }>;
  /** PostMind staff: one org-wide row per STUDIO_PLATFORM_ORG_IDS organisation, plus the webhook. */
  notifyStaff(input: StaffNotificationInput): Promise<number>;
}

type NotificationClient = Pick<PrismaClient, 'notification'>;

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
}): Notifier {
  const sender = bestEffort(deps.sender ?? notificationSenderFromEnv(), deps.logger);
  const staffOrgIds = deps.staffOrgIds ?? (() => staffOrganisationIds());

  async function store(input: NotificationInput) {
    const data = {
      organisationId: input.organisationId,
      userId: input.userId ?? null,
      kind: input.kind,
      title: input.title.slice(0, TITLE_MAX),
      body: input.body.slice(0, BODY_MAX),
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
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
      const row = await store(input);
      if (!row) return { created: false };
      await sender.send({ ...row, audience: 'organisation' });
      return { created: true, id: row.id };
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

type NotifierHost = { db: PrismaClient; logger: Logger; notifier?: Notifier };

const notifiers = new WeakMap<object, Notifier>();

/** The host's injected notifier, or one built from its db/logger and env (memoised per host). */
export function notifierFor(host: NotifierHost): Notifier {
  if (host.notifier) return host.notifier;
  let notifier = notifiers.get(host);
  if (!notifier) {
    notifier = createNotifier({ db: host.db, logger: host.logger });
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
