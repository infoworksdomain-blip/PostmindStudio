import { ProviderError } from '../../errors';
import type { ProviderErrorClass } from './interface';

export interface ErrorClassification {
  errorClass: ProviderErrorClass;
  retryable: boolean;
}

/** Map an HTTP status from any provider to a Studio error class. */
export function classifyHttpStatus(status: number): ErrorClassification {
  if (status === 401 || status === 403) return { errorClass: 'auth', retryable: false };
  if (status === 402) return { errorClass: 'insufficient_credits', retryable: false };
  if (status === 408) return { errorClass: 'timeout', retryable: true };
  if (status === 409) return { errorClass: 'provider_unavailable', retryable: true };
  if (status === 429) return { errorClass: 'rate_limited', retryable: true };
  if (status >= 500) return { errorClass: 'provider_unavailable', retryable: true };
  if (status >= 400) return { errorClass: 'invalid_request', retryable: false };
  return { errorClass: 'unknown', retryable: false };
}

export function providerError(
  providerId: string,
  classification: ErrorClassification,
  message: string,
  details?: Record<string, unknown>,
): ProviderError {
  return new ProviderError(
    providerId,
    classification.errorClass,
    message,
    classification.retryable,
    details,
  );
}

/** Fetch-level failures (DNS, reset, abort on timeout) before any HTTP status exists. */
export function classifyNetworkError(err: unknown): ErrorClassification {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { errorClass: 'timeout', retryable: true };
  }
  return { errorClass: 'provider_unavailable', retryable: true };
}

/**
 * 20.11: text about a failure that may be shown to customers (e.g. a scan's error list). A
 * provider's own message (which can be a raw JSON body) is replaced by `<provider>/<class>`; the
 * full message stays in logs and provider_jobs.
 */
export function publicErrorText(err: unknown): string {
  if (err instanceof ProviderError) return `${err.providerId}/${err.errorClass}`;
  return err instanceof Error ? err.message : String(err);
}

// BACKLOG 20.19 (production 2026-10-02): Runway answered a text_to_video submit with
// "You do not have enough credits to run this task." Runway's error matrix
// (docs.dev.runwayml.com/errors/errors, read 2026-10-02) gives every input problem the same
// 400 { error: "<human-readable explanation>" } and documents no credit code, so the account
// problem was classified invalid_request: no failover to Luma, no account hold, no alert.
// Several providers report an empty balance as a plain 400 / 422 with only a sentence, so a 4xx
// that would otherwise be invalid_request / unknown is an account problem when its message says
// the balance is gone. Conservative on purpose: only out-of-credit wording, never generic text.
const OUT_OF_CREDIT_MESSAGE =
  /\b(?:not have enough credits?|not enough credits?|insufficient (?:api )?(?:credits?|balance|funds)|out of credits?|no (?:remaining )?credits? (?:left|remaining)|credit balance (?:is )?(?:exhausted|too low|insufficient))\b/i;

/** True when a provider's message says the account has no credit / balance left. */
export function isOutOfCreditMessage(message: string | null | undefined): boolean {
  return Boolean(message && OUT_OF_CREDIT_MESSAGE.test(message));
}

/**
 * The classification for a failed HTTP response: `refined` (an adapter's documented error code)
 * when given, else the status class — upgraded to insufficient_credits when an input-error
 * status carries out-of-credit wording.
 */
export function classifyHttpFailure(
  status: number,
  message: string,
  refined?: ErrorClassification,
): ErrorClassification {
  if (refined) return refined;
  const byStatus = classifyHttpStatus(status);
  if (
    (byStatus.errorClass === 'invalid_request' || byStatus.errorClass === 'unknown') &&
    isOutOfCreditMessage(message)
  ) {
    return { errorClass: 'insufficient_credits', retryable: false };
  }
  return byStatus;
}
