import { APIError } from 'better-auth/api';
import type { AuthRateLimitStore, RateRule } from './rate-limit-store';

// Phase 19.3 — limits keyed by account, organisation or inviter rather than by client IP, so an
// attacker rotating addresses gains nothing. They run in Better Auth's before-hook (config.ts),
// which also runs for server-side `auth.api.*` calls (dispatchAuthEndpoint in better-auth@1.7.6),
// so Studio's own invite route (membership-gateway-better-auth.ts) is covered too. The per-IP
// rules (AUTH_RATE_RULES) and Better Auth's 2FA account lockout (10 consecutive failures, 15
// minutes: plugins/two-factor/verify-two-factor.mjs) still apply on top.

/** Endpoints that check a second factor during sign-in or enrolment. */
export const TWO_FACTOR_VERIFY_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);

/** 5 second-factor attempts per 10 minutes per account (signed in or a pending sign-in). */
export const TWO_FACTOR_ACCOUNT_RULE: RateRule = { window: 10 * 60, max: 5 };

export const INVITE_PATH = '/organization/invite-member';
/** 20 invitations (including resends) per organisation per hour. */
export const INVITE_ORGANISATION_RULE: RateRule = { window: 60 * 60, max: 20 };
/**
 * 30 invitations per inviter per hour, across all their organisations: one account in many
 * organisations cannot multiply the organisation budget.
 */
export const INVITE_INVITER_RULE: RateRule = { window: 60 * 60, max: 30 };

export interface LimitCheck {
  key: string;
  rule: RateRule;
}

/** The one 429 every Studio-added auth limit answers (the same whatever the account state). */
export function tooManyRequests(retryAfterSec: number): APIError {
  return new APIError(
    'TOO_MANY_REQUESTS',
    { message: 'Too many requests. Try again later.', code: 'RATE_LIMITED' },
    { 'X-Retry-After': String(retryAfterSec) },
  );
}

/** Consumes each check in order; throws a 429 at the first one that is over its limit. */
export async function enforceLimits(
  store: AuthRateLimitStore,
  checks: readonly LimitCheck[],
): Promise<void> {
  for (const check of checks) {
    const result = await store.consume(check.key, check.rule);
    if (!result.allowed) throw tooManyRequests(result.retryAfter ?? check.rule.window);
  }
}

export function twoFactorChecks(userId: string): LimitCheck[] {
  return [{ key: `2fa:user:${userId}`, rule: TWO_FACTOR_ACCOUNT_RULE }];
}

/**
 * The organisation budget is only charged when the inviter is a member of it (`isMember`): a
 * stranger naming someone else's organisation must not be able to use up its invites (the
 * endpoint refuses them anyway).
 */
export function inviteChecks(input: {
  inviterId: string;
  organisationId: string | null;
  isMember: boolean;
}): LimitCheck[] {
  const checks: LimitCheck[] = [];
  if (input.organisationId && input.isMember) {
    checks.push({ key: `invite:org:${input.organisationId}`, rule: INVITE_ORGANISATION_RULE });
  }
  checks.push({ key: `invite:inviter:${input.inviterId}`, rule: INVITE_INVITER_RULE });
  return checks;
}
