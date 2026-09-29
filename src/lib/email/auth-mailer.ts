import type { Logger } from 'pino';

// Phase 18 §2.8 — the contract between the auth / org / billing code that needs to send a
// transactional email and Track B's Resend sender (outbox, retries, React Email templates in the
// `email.*` namespace, suppression). Callers pass a template id, the address, template params and
// the recipient's locale; they never build subjects or bodies themselves.

export const AUTH_EMAIL_TEMPLATES = [
  // transactional (auth)
  'verifyEmail',
  'resetPassword',
  'passwordChanged',
  'emailChangeConfirm',
  'emailChanged',
  'accountExists',
  'twoFactorChanged',
  'newSignIn',
  // organisation
  'invite',
  'ownershipTransferred',
  // billing
  'trialEnding',
  'paymentFailed',
  'paymentActionRequired',
  'subscriptionChanged',
  'subscriptionCanceled',
  'topupReceipt',
  // account
  'accountDeletionScheduled',
  'orgDeletionScheduled',
  'dataExportReady',
] as const;

export type AuthEmailTemplate = (typeof AUTH_EMAIL_TEMPLATES)[number];

/** Template params: plain values only (URLs, names, dates as ISO strings, counts). */
export type AuthEmailParams = Record<string, string | number | boolean | null>;

export interface AuthEmailOptions {
  /** Dedupe key for the outbox (e.g. `auth:<verificationId>`); a repeat is not sent twice. */
  idempotencyKey?: string;
  organisationId?: string;
  userId?: string;
}

export interface AuthMailer {
  /**
   * Queue one email. Resolves once it is recorded (outbox), not when it is delivered; rejects
   * only when it could not be recorded. A suppressed address resolves with `suppressed: true`.
   */
  sendAuthEmail(
    template: AuthEmailTemplate,
    to: string,
    params: AuthEmailParams,
    locale: string,
    options?: AuthEmailOptions,
  ): Promise<{ queued: boolean; suppressed: boolean }>;
}

export interface SentAuthEmail {
  template: AuthEmailTemplate;
  to: string;
  params: AuthEmailParams;
  locale: string;
  options?: AuthEmailOptions;
}

/** Tests: records every email in memory. */
export function createMemoryAuthMailer(): AuthMailer & { sent: SentAuthEmail[] } {
  const sent: SentAuthEmail[] = [];
  return {
    sent,
    async sendAuthEmail(template, to, params, locale, options) {
      sent.push({ template, to, params, locale, options });
      return { queued: true, suppressed: false };
    },
  };
}

/**
 * Local development only: logs the template, recipient domain and any link so a developer can
 * follow a verify / reset link without an email provider. Never used when NODE_ENV=production.
 */
export function createConsoleAuthMailer(log: Logger): AuthMailer {
  return {
    async sendAuthEmail(template, to, params, locale) {
      const url = typeof params.url === 'string' ? params.url : undefined;
      log.info(
        { template, toDomain: to.split('@')[1] ?? '', locale, url },
        '[email:console] transactional email (development transport, not sent)',
      );
      return { queued: true, suppressed: false };
    },
  };
}

/** Production without a usable sender: records nothing and logs an error, so it is loud. */
export function createUnconfiguredAuthMailer(log: Logger): AuthMailer {
  return {
    async sendAuthEmail(template) {
      log.error({ template }, '[email] no transactional email sender is configured');
      return { queued: false, suppressed: false };
    },
  };
}

/**
 * The mailer auth/server.ts and other request-time senders use. Tests always get the console
 * transport. Otherwise it is the process's ApiDeps mailer (src/lib/email/mailer.ts
 * `mailerFromEnv`): Track B's Resend outbox mailer when STUDIO_EMAIL_PROVIDER is `resend`, the
 * console transport in development without RESEND_API_KEY, and a loud no-op in production when
 * no sender is configured.
 */
export async function authMailerFromEnv(log: Logger): Promise<AuthMailer> {
  if (process.env.NODE_ENV === 'test') return createConsoleAuthMailer(log);
  const { getApiDeps } = await import('../studio/api/context');
  const { mailer } = await getApiDeps();
  if (mailer) return mailer;
  if (process.env.NODE_ENV !== 'production') return createConsoleAuthMailer(log);
  return createUnconfiguredAuthMailer(log);
}
