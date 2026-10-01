import { ProviderError } from '../../errors';
import { ACCOUNT_ERROR_CLASSES, type ProviderErrorClass } from './interface';

// BACKLOG 20.11 — provider ACCOUNT problems (production 2026-09-30: Anthropic answered a website
// scan with 400 "You have reached your specified API usage limits …" and the raw JSON reached the
// customer). An account problem (bad key, no credits, usage / spend limit) is not fixed by
// retrying the same provider, so:
//   - the provider is held out of routing for a cooldown (circuit-breaker tripAccount): 15 minutes
//     by default, or until the time the provider says access resumes (Anthropic "You will regain
//     access on 2026-10-01 at 00:00 UTC"), capped at ACCOUNT_HOLD_MAX_MS;
//   - the running operation fails over to the next provider for the capability at once
//     (pipeline/provider-run.ts);
//   - the operator gets one deduplicated alert (providers/account-alerts.ts).

export const ACCOUNT_HOLD_MS = 15 * 60_000;
/** A provider-stated resume time further away than this is treated as this (clock / parse guard). */
export const ACCOUNT_HOLD_MAX_MS = 32 * 24 * 60 * 60_000;
/** Reasons kept on the breaker (admin view) are trimmed to this many characters. */
export const ACCOUNT_REASON_MAX = 500;

export function isAccountErrorClass(errorClass: string | undefined | null): boolean {
  return ACCOUNT_ERROR_CLASSES.has((errorClass ?? '') as ProviderErrorClass);
}

export function isAccountProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError && isAccountErrorClass(err.errorClass);
}

// Anthropic spend limits (platform.claude.com/docs/en/api/rate-limits, read 2026-09-30): the
// message "states when access resumes", e.g. "You will regain access on 2026-09-01 at 00:00 UTC."
const REGAIN_AT = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}):(\d{2}) UTC/i;

/** The resume time a provider states in its message, if any. */
export function parseRegainAt(message: string): Date | undefined {
  const match = REGAIN_AT.exec(message);
  if (!match) return undefined;
  const at = new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** When a held provider may be tried again (ms since epoch). */
export function accountHoldUntil(now: number, retryAt?: Date | string | null): number {
  const stated = retryAt ? new Date(retryAt).getTime() : Number.NaN;
  if (Number.isFinite(stated) && stated > now) return Math.min(stated, now + ACCOUNT_HOLD_MAX_MS);
  return now + ACCOUNT_HOLD_MS;
}

/** The resume time carried in a ProviderError's details (set by the adapters), if any. */
export function retryAtOf(err: unknown): string | undefined {
  if (!(err instanceof ProviderError)) return undefined;
  const value = err.details?.retryAt;
  return typeof value === 'string' ? value : undefined;
}
