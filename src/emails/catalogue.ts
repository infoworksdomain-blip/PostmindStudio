import { AUTH_EMAIL_TEMPLATES, type AuthEmailTemplate } from '../lib/email/auth-mailer';

// Phase 18 §2.8 (Track B) — every email Studio sends, with the parameters each one needs. The
// words live in messages/<locale>.json → email.templates.<template> (subject, heading, body,
// cta?, note?), so a template here is only its contract:
//
//   required  params the caller must pass (checked when the email is queued, so a bad call fails
//             in the caller instead of in the worker)
//   dates     params that are ISO 8601 date strings, formatted in the reader's locale
//   cta       the button: the `url` param, or `defaultPath` on APP_URL when no url is passed
//   category  auth / organisation / billing / account mail cannot be unsubscribed from;
//             `notification` mail carries a one-click unsubscribe link (RFC 8058)
//
// Params that are links must be absolute http(s) URLs (checked at queue time and at render time).

export type EmailTemplate = AuthEmailTemplate | 'notification';

export type EmailCategory = 'auth' | 'organisation' | 'billing' | 'account' | 'notification';

export interface TemplateSpec {
  category: EmailCategory;
  required: readonly string[];
  dates?: readonly string[];
  /** Button target when the caller passes no `url` (a path on APP_URL). */
  defaultPath?: string;
  /** false = no button even when a url is passed. Default true. */
  cta?: boolean;
}

/** Params that carry links. Values must be absolute http(s) URLs. */
export const URL_PARAMS: ReadonlySet<string> = new Set(['url', 'link']);

/** Params removed from the outbox row once the email is sent (they carry one-time tokens). */
export const SECRET_PARAMS: ReadonlySet<string> = new Set(['url']);

export const TEMPLATES: Record<EmailTemplate, TemplateSpec> = {
  verifyEmail: { category: 'auth', required: ['url'] },
  resetPassword: { category: 'auth', required: ['url'] },
  passwordChanged: { category: 'auth', required: [], defaultPath: '/account/security' },
  emailChangeConfirm: { category: 'auth', required: ['url', 'newEmail'] },
  emailChanged: { category: 'auth', required: ['newEmail'], defaultPath: '/account/security' },
  accountExists: { category: 'auth', required: [], defaultPath: '/sign-in' },
  twoFactorChanged: {
    category: 'auth',
    required: ['enabled'],
    defaultPath: '/account/security',
  },
  newSignIn: { category: 'auth', required: ['device'], defaultPath: '/account/security' },
  invite: {
    category: 'organisation',
    required: ['url', 'organisationName', 'inviterName', 'role'],
  },
  ownershipTransferred: {
    category: 'organisation',
    required: ['organisationName', 'newOwnerName'],
    defaultPath: '/settings/organisation',
  },
  trialEnding: {
    category: 'billing',
    required: ['planName', 'trialEndsAt'],
    dates: ['trialEndsAt'],
    defaultPath: '/settings/billing',
  },
  paymentFailed: {
    category: 'billing',
    required: ['graceEndsAt'],
    dates: ['graceEndsAt'],
    defaultPath: '/settings/billing',
  },
  paymentActionRequired: { category: 'billing', required: ['url'] },
  subscriptionChanged: {
    category: 'billing',
    required: ['planName'],
    defaultPath: '/settings/billing',
  },
  subscriptionCanceled: {
    category: 'billing',
    required: ['endsAt'],
    dates: ['endsAt'],
    defaultPath: '/settings/billing',
  },
  topupReceipt: { category: 'billing', required: ['packName'], defaultPath: '/settings/billing' },
  accountDeletionScheduled: {
    category: 'account',
    required: ['deleteAt'],
    dates: ['deleteAt'],
    cta: false,
  },
  orgDeletionScheduled: {
    category: 'account',
    required: ['organisationName', 'deleteAt'],
    dates: ['deleteAt'],
    cta: false,
  },
  dataExportReady: {
    category: 'account',
    required: ['url', 'expiresAt'],
    dates: ['expiresAt'],
  },
  // The generic notification email (§2.8): renders notifications.<messageKey>.title/body with
  // messageParams in the reader's locale, or the stored English subject/text for unkeyed rows.
  notification: { category: 'notification', required: ['kind', 'subject', 'text'] },
};

export const EMAIL_TEMPLATES: readonly EmailTemplate[] = [...AUTH_EMAIL_TEMPLATES, 'notification'];

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

/** Only notification mail can be unsubscribed from; auth, billing and account mail cannot. */
export function isUnsubscribable(template: EmailTemplate): boolean {
  return TEMPLATES[template].category === 'notification';
}
