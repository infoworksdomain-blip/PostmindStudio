import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { EmailOutbox } from '../../email/outbox';
import type { EmailMessage, EmailSender } from './email';

// Phase 18 §2.8 — notification email through Resend (runbooks/notifications-email.md, option B).
// The notifier passes the user ids that opted in to email for the kind (EmailPreferenceLookup);
// this sender resolves their addresses from studio.users and drops anyone who is deleted, banned
// or unverified (the outbox then drops suppressed addresses). Each recipient gets one outbox row,
// keyed `notification:<notificationId>:<userId>`, rendered later in that user's locale with the
// one-click unsubscribe link for this kind.

type Db = Pick<PrismaClient, 'user'>;

const MAX_RECIPIENTS = 1_000;

export function notificationEmailKey(notificationId: string, userId: string): string {
  return `notification:${notificationId}:${userId}`;
}

export class ResendEmailSender implements EmailSender {
  readonly provider = 'resend' as const;

  constructor(private readonly deps: { db: Db; outbox: EmailOutbox; logger: Logger }) {}

  async send(message: EmailMessage): Promise<void> {
    const ids = [...new Set(message.recipientUserIds)].slice(0, MAX_RECIPIENTS);
    if (ids.length === 0) return;
    const users = await this.deps.db.user.findMany({
      where: {
        id: { in: ids },
        emailVerified: true,
        deletedAt: null,
        NOT: { banned: true },
      },
      select: { id: true, email: true, name: true, locale: true },
    });
    const dropped = ids.length - users.length;
    if (dropped > 0) {
      this.deps.logger.info(
        { notificationId: message.notificationId, dropped },
        'notification email skipped for unverified, deleted or unknown users',
      );
    }
    for (const user of users) {
      await this.deps.outbox.enqueue({
        idempotencyKey: notificationEmailKey(message.notificationId, user.id),
        to: user.email,
        template: 'notification',
        locale: user.locale,
        organisationId: message.organisationId,
        userId: user.id,
        params: {
          kind: message.kind,
          subject: message.subject,
          text: message.text,
          link: message.link && /^https?:\/\//.test(message.link) ? message.link : null,
          name: user.name || null,
          notificationId: message.notificationId,
          ...(message.message && {
            messageKey: message.message.key,
            messageParams: JSON.stringify(message.message.params),
          }),
        },
      });
    }
  }
}
