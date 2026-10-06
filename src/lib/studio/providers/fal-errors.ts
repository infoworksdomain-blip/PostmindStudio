import type { ProviderErrorClass } from './interface';
import { isOutOfCreditMessage, type ErrorClassification } from './provider-errors';

// BACKLOG 24.1 — fal.ai error mapping (providers/fal.ts). From
// https://fal.ai/docs/documentation/model-apis/errors.md (read 2026-10-06): model errors are
// 422 { detail: [{ loc, msg, type, url, ctx?, input? }] } (`type` is the machine-readable code,
// e.g. content_policy_violation, one_of, image_too_large); request errors are a flat
// { detail, error_type } (+ X-Fal-Error-Type): request_timeout / startup_timeout 504,
// runner_* 502/503/500, internal_error 500, bad_request 400, client_* 499. A queued request that
// fails reports the same error_type with `error` on its COMPLETED status.

/** fal's error_type values (errors.md) → Studio classes. */
export function classifyFalErrorType(
  errorType: string | null | undefined,
  message?: string | null,
): { class: ProviderErrorClass; retryable: boolean } {
  switch (errorType) {
    case 'content_policy_violation':
      return { class: 'content_policy', retryable: false };
    case 'request_timeout':
    case 'startup_timeout':
      return { class: 'timeout', retryable: true };
    case 'runner_scheduling_failure':
    case 'runner_connection_timeout':
    case 'runner_disconnected':
    case 'runner_connection_refused':
    case 'runner_connection_error':
    case 'runner_incomplete_response':
    case 'runner_server_error':
    case 'internal_error':
      return { class: 'provider_unavailable', retryable: true };
    case 'bad_request':
      return { class: 'invalid_request', retryable: false };
    default:
      if (isFalBalanceMessage(message)) return { class: 'insufficient_credits', retryable: false };
      return { class: 'unknown', retryable: false };
  }
}

// fal documents a prepaid balance but no wording for an empty one (pricing.md); the operator's
// brief names "exhausted balance" / "insufficient balance". Kept local to fal (with the shared
// out-of-credit wording) rather than widening provider-errors.ts on undocumented text.
const FAL_BALANCE = /\b(?:exhausted|insufficient) balance\b/i;

function isFalBalanceMessage(message: string | null | undefined): boolean {
  return Boolean(message && (FAL_BALANCE.test(message) || isOutOfCreditMessage(message)));
}

interface FalDetailItem {
  msg?: unknown;
  type?: unknown;
}

function detailItems(body: unknown): FalDetailItem[] {
  if (!body || typeof body !== 'object' || !('detail' in body)) return [];
  const detail = (body as { detail: unknown }).detail;
  return Array.isArray(detail) ? (detail as FalDetailItem[]) : [];
}

export function falErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  const items = detailItems(body);
  if (items.length > 0) {
    return items.map((i) => `${String(i.type ?? 'error')}: ${String(i.msg ?? '')}`).join('; ');
  }
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}

/** HTTP refinements on top of classifyHttpStatus (provider-errors.ts). */
export function classifyFalHttpError(
  status: number,
  body: unknown,
): ErrorClassification | undefined {
  if (isFalBalanceMessage(falErrorMessage(body))) {
    return { errorClass: 'insufficient_credits', retryable: false };
  }
  if (status === 422) {
    const refused = detailItems(body).some((i) => i.type === 'content_policy_violation');
    return refused
      ? { errorClass: 'content_policy', retryable: false }
      : { errorClass: 'invalid_request', retryable: false };
  }
  if (status === 504) return { errorClass: 'timeout', retryable: true };
  return undefined;
}
