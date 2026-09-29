import { ConfigurationError } from '../errors';

// Phase 18 §2.8 / §6 — Resend settings. src/lib/env.ts already refuses to start a production
// web process in email mode `resend` without RESEND_API_KEY, RESEND_WEBHOOK_SECRET,
// STUDIO_EMAIL_FROM and STUDIO_UNSUBSCRIBE_SECRET; these readers fail with a ConfigurationError
// at first use for processes that skip that check (the worker, scripts).

type Env = Record<string, string | undefined>;

export const UNSUBSCRIBE_SECRET_MIN_LENGTH = 32;

export interface EmailSendConfig {
  apiKey: string;
  /** "PostMind Studio <no-reply@mail.example.com>" — a verified Resend domain. */
  from: string;
  replyTo?: string;
  appUrl: string;
  supportEmail?: string;
  unsubscribeSecret: string;
}

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (!value) throw new ConfigurationError(`${name} is not set (email provider resend)`);
  return value;
}

export function unsubscribeSecretFromEnv(env: Env = process.env): string {
  const secret = required(env, 'STUDIO_UNSUBSCRIBE_SECRET');
  if (secret.length < UNSUBSCRIBE_SECRET_MIN_LENGTH) {
    throw new ConfigurationError(
      `STUDIO_UNSUBSCRIBE_SECRET must be at least ${UNSUBSCRIBE_SECRET_MIN_LENGTH} characters`,
    );
  }
  return secret;
}

export function webhookSecretFromEnv(env: Env = process.env): string {
  return required(env, 'RESEND_WEBHOOK_SECRET');
}

export function emailSendConfigFromEnv(env: Env = process.env): EmailSendConfig {
  const replyTo = read(env, 'STUDIO_EMAIL_REPLY_TO');
  const supportEmail = read(env, 'STUDIO_SUPPORT_EMAIL');
  return {
    apiKey: required(env, 'RESEND_API_KEY'),
    from: required(env, 'STUDIO_EMAIL_FROM'),
    ...(replyTo && { replyTo }),
    appUrl: required(env, 'APP_URL').replace(/\/+$/, ''),
    ...(supportEmail && { supportEmail }),
    unsubscribeSecret: unsubscribeSecretFromEnv(env),
  };
}
