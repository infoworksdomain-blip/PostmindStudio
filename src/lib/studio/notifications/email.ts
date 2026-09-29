import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { NotImplementedError } from '../../errors';
import { createEmailOutbox } from '../../email/outbox';
import { studioModes, type StudioModes } from '../../mode';
import type { JobQueue } from '../queue/enqueue';
import type { NotificationKind } from './notifier';
import { ResendEmailSender } from './resend-sender';

// BACKLOG 13.33 / Phase 18 §2.8 — email delivery for notifications (spec 14.4).
//
// Operator decision (2026-09-29, runbooks/notifications-email.md): option B — Studio sends email
// itself through Resend (ResendEmailSender, resend-sender.ts): addresses come from studio.users,
// the outbox + `send-email` job deliver it, bounces and complaints suppress the address, and
// every notification email carries a one-click unsubscribe link. Option A (PostMind Core sends
// it) stays available for core mode: CoreEmailSender throws NotImplementedError until Core
// publishes an email API, so opted-in email is recorded as pending setup there.
//
// The sender follows STUDIO_EMAIL_PROVIDER through src/lib/mode.ts: standalone mode defaults to
// "resend", core mode to "none" (no sender: pending setup); "core" selects CoreEmailSender.
// createEmailSender() builds it; emailSenderFromEnv() is the database-free subset (core / none).

/** Delivery state stored on studio.notifications.emailStatus (null = email not requested). */
export type EmailStatus = 'pending_setup' | 'sent' | 'failed';

export interface EmailMessage {
  /** The studio.notifications row this email belongs to. */
  notificationId: string;
  organisationId: string;
  /** PostMind user ids who opted in to email for this kind. Core resolves their addresses. */
  recipientUserIds: string[];
  kind: NotificationKind;
  subject: string;
  text: string;
  /** Absolute when APP_URL is set, otherwise the app-relative path. */
  link: string | null;
  /** 16.5: the keyed form, rendered in each recipient's locale (absent for unkeyed rows). */
  message?: { key: string; params: Record<string, string | number> };
}

export interface EmailSender {
  readonly provider: 'core' | 'resend';
  send(message: EmailMessage): Promise<void>;
}

export const CORE_EMAIL_PENDING_MESSAGE = 'waiting for a PostMind Core email API';

/**
 * Option A. PROPOSED Core contract (not published by Core; do not call until it is):
 *   POST {POSTMIND_CORE_URL}/api/internal/notifications/email   X-Service-Token
 *   { organisationId, userIds[], subject, text, link, idempotencyKey: notificationId }
 *   → 202 { accepted: number }
 */
export class CoreEmailSender implements EmailSender {
  readonly provider = 'core' as const;

  async send(_message: EmailMessage): Promise<void> {
    throw new NotImplementedError(CORE_EMAIL_PENDING_MESSAGE);
  }
}

export type EmailProvider = StudioModes['email'];

/** STUDIO_EMAIL_PROVIDER as resolved by src/lib/mode.ts (invalid values throw). */
export function emailProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailProvider {
  return studioModes(env).email;
}

/**
 * The database-free senders: "core" = CoreEmailSender, "none" = null. "resend" needs the
 * database and the queue, so it returns null here — production wiring uses createEmailSender().
 */
export function emailSenderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailSender | null {
  return emailProviderFromEnv(env) === 'core' ? new CoreEmailSender() : null;
}

/** The sender for STUDIO_EMAIL_PROVIDER (null = none: opted-in email is pending setup). */
export function createEmailSender(deps: {
  db: PrismaClient;
  queue?: JobQueue;
  logger: Logger;
  env?: Record<string, string | undefined>;
}): EmailSender | null {
  const provider = emailProviderFromEnv(deps.env);
  if (provider === 'core') return new CoreEmailSender();
  if (provider === 'none') return null;
  return new ResendEmailSender({
    db: deps.db,
    outbox: createEmailOutbox({ db: deps.db, queue: deps.queue, logger: deps.logger }),
    logger: deps.logger,
  });
}

/**
 * The part of the notification-preferences service (BACKLOG 13.24, track A3) the notifier needs:
 * which users asked for email for this kind. For a user notification that is the user (when
 * opted in); for an organisation-wide one (userId null), every member with email enabled.
 */
export interface EmailPreferenceLookup {
  emailRecipients(input: {
    organisationId: string;
    userId: string | null;
    kind: NotificationKind;
  }): Promise<string[]>;
}
