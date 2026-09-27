import { ConfigurationError, NotImplementedError } from '../../errors';
import type { NotificationKind } from './notifier';

// BACKLOG 13.33 — email delivery for notifications (spec 14.4). The contract is final; delivery
// is not built because it waits on an OPERATOR DECISION (runbooks/notifications-email.md):
//
//   A. PostMind Core sends email. Studio passes user ids; Core resolves addresses, templates,
//      unsubscribe and bounce handling. No Core email API is documented today, so
//      CoreEmailSender throws NotImplementedError until Core publishes one.
//   B. Studio sends email itself (Resend or Amazon SES). Studio would then need each user's
//      address from Core (the context endpoint carries none), a verified sending domain, its own
//      unsubscribe link and bounce/complaint handling. Not built: no adapter without that decision.
//
// STUDIO_EMAIL_PROVIDER selects the sender: unset or "none" = no email sender (email is
// recorded as pending setup); "core" = CoreEmailSender. Anything else is a configuration error,
// including "resend" / "ses" until option B is chosen and built.

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
}

export interface EmailSender {
  readonly provider: 'core';
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

export type EmailProvider = 'none' | 'core';

export function emailProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailProvider {
  const raw = env.STUDIO_EMAIL_PROVIDER?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'none') return 'none';
  if (raw === 'core') return 'core';
  if (raw === 'resend' || raw === 'ses') {
    throw new ConfigurationError(
      `STUDIO_EMAIL_PROVIDER=${raw} is not built: Studio-sent email needs an operator decision (runbooks/notifications-email.md)`,
    );
  }
  throw new ConfigurationError('STUDIO_EMAIL_PROVIDER must be unset, "none" or "core"');
}

/** null = no email sender configured: opted-in email is recorded as pending setup. */
export function emailSenderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailSender | null {
  return emailProviderFromEnv(env) === 'core' ? new CoreEmailSender() : null;
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
