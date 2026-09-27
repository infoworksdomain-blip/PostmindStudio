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
