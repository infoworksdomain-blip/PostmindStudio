'use client';

// Phase 18 Track A — the browser side of sign-in. The screens call Better Auth's endpoints under
// /api/auth/* directly (same origin, cookie session; the server sets and reads the HttpOnly cookie,
// no token is ever visible to JavaScript). A small fetch wrapper rather than better-auth/react:
// the screens need a handful of endpoints, and error codes must map onto `auth.errors.*` keys.
// Endpoint paths and bodies: https://www.better-auth.com/docs/authentication/email-password,
// /docs/plugins/2fa, /docs/concepts/session-management, /docs/plugins/organization (read
// 2026-09-29), checked against better-auth@1.7.6.

export const AUTH_BASE = '/api/auth';

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

export async function authFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const body = (json ?? {}) as { code?: string; message?: string };
    const retry = Number(res.headers.get('x-retry-after'));
    throw new AuthApiError(
      res.status,
      body.code ?? (res.status === 429 ? 'RATE_LIMITED' : `HTTP_${res.status}`),
      body.message ?? res.statusText,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  return json as T;
}

/** Catalogue key (auth.errors.<key>) for an auth error; never the server's raw message. */
export type AuthErrorKey =
  | 'invalidCredentials'
  | 'emailNotVerified'
  | 'passwordTooShort'
  | 'passwordTooLong'
  | 'passwordCompromised'
  | 'rateLimited'
  | 'invalidToken'
  | 'invalidCode'
  | 'locked'
  | 'signupsClosed'
  | 'invalidEmail'
  | 'seatLimit'
  | 'inviteNotForYou'
  | 'network'
  | 'generic';

export function authErrorKey(err: unknown): AuthErrorKey {
  if (!(err instanceof AuthApiError)) return err instanceof TypeError ? 'network' : 'generic';
  switch (err.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'INVALID_PASSWORD':
      return 'invalidCredentials';
    case 'EMAIL_NOT_VERIFIED':
      return 'emailNotVerified';
    case 'PASSWORD_TOO_SHORT':
      return 'passwordTooShort';
    case 'PASSWORD_TOO_LONG':
      return 'passwordTooLong';
    case 'PASSWORD_COMPROMISED':
      return 'passwordCompromised';
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
    case 'INVALID_TWO_FACTOR_COOKIE':
      return 'invalidToken';
    case 'INVALID_CODE':
    case 'INVALID_TWO_FACTOR_CODE':
    case 'INVALID_BACKUP_CODE':
    case 'OTP_HAS_EXPIRED':
      return 'invalidCode';
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return 'locked';
    case 'EMAIL_PASSWORD_SIGN_UP_DISABLED':
      return 'signupsClosed';
    case 'INVALID_EMAIL':
      return 'invalidEmail';
    case 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED':
      return 'seatLimit';
    case 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION':
    case 'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION':
      return 'inviteNotForYou';
    default:
      return err.status === 429 ? 'rateLimited' : 'generic';
  }
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled?: boolean | null;
  locale?: string | null;
}

export interface SessionPayload {
  session: { id: string; token: string; activeOrganizationId?: string | null; createdAt: string };
  user: SessionUser;
}

export const authApi = {
  getSession: () => authFetch<SessionPayload | null>('/get-session'),
  signUp: (body: { name: string; email: string; password: string; callbackURL: string }) =>
    authFetch<unknown>('/sign-up/email', { body }),
  signIn: (body: { email: string; password: string; callbackURL?: string }) =>
    authFetch<{ twoFactorRedirect?: boolean }>('/sign-in/email', { body }),
  signInGoogle: (callbackURL: string, errorCallbackURL: string) =>
    authFetch<{ url?: string }>('/sign-in/social', {
      body: { provider: 'google', callbackURL, errorCallbackURL },
    }),
  signOut: () => authFetch<unknown>('/sign-out', { body: {} }),
  resendVerification: (email: string, callbackURL: string) =>
    authFetch<unknown>('/send-verification-email', { body: { email, callbackURL } }),
  requestReset: (email: string) =>
    authFetch<unknown>('/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
    }),
  resetPassword: (token: string, newPassword: string) =>
    authFetch<unknown>('/reset-password', { body: { token, newPassword } }),
  verifyTotp: (code: string, trustDevice: boolean) =>
    authFetch<unknown>('/two-factor/verify-totp', { body: { code, trustDevice } }),
  verifyBackupCode: (code: string) =>
    authFetch<unknown>('/two-factor/verify-backup-code', { body: { code } }),
};
