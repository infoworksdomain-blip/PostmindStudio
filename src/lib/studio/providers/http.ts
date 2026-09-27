import { classifyHttpStatus, classifyNetworkError, providerError } from './provider-errors';

// Minimal JSON-over-HTTP helper for REST providers without an official SDK in this repo.
// Network failures and non-2xx responses become typed ProviderErrors.

export interface HttpJsonOptions {
  providerId: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Pull a human-readable message out of a provider's error body. */
  errorMessage?: (body: unknown) => string | undefined;
}

export interface HttpJsonResponse<T> {
  status: number;
  body: T;
}

export async function httpJson<T>(
  url: string,
  init: RequestInit,
  options: HttpJsonOptions,
): Promise<HttpJsonResponse<T>> {
  let res: Response;
  try {
    res = await options.fetchImpl(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (err) {
    throw providerError(options.providerId, classifyNetworkError(err), (err as Error).message);
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message = options.errorMessage?.(body) ?? `HTTP ${res.status}`;
    throw providerError(options.providerId, classifyHttpStatus(res.status), message, {
      status: res.status,
    });
  }
  return { status: res.status, body: body as T };
}
