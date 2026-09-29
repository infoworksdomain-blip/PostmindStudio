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

/**
 * The mailer production wiring uses (auth/server.ts and other senders). Track B points this at the
 * Resend sender (outbox + queue). Until then: the console transport outside production, and in
 * production a mailer that records nothing and logs an error, so a missing sender is loud.
 */
export async function authMailerFromEnv(log: Logger): Promise<AuthMailer> {
  if (process.env.NODE_ENV !== 'production') return createConsoleAuthMailer(log);
  return {
    async sendAuthEmail(template) {
      log.error({ template }, '[email] no transactional email sender is configured');
      return { queued: false, suppressed: false };
    },
  };
}
