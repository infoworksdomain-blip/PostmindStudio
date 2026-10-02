import {
  classifyHttpFailure,
  classifyNetworkError,
  providerError,
  type ErrorClassification,
} from './provider-errors';

// Minimal JSON-over-HTTP helper for REST providers without an official SDK in this repo.
// Network failures and non-2xx responses become typed ProviderErrors.

export interface HttpJsonOptions {
  providerId: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Pull a human-readable message out of a provider's error body. */
  errorMessage?: (body: unknown) => string | undefined;
  /**
   * Refine the status-based classification from a provider's documented error body (e.g. a
   * 400 whose error code means a content-policy rejection). Return undefined to keep the default.
   */
  classifyError?: (status: number, body: unknown) => ErrorClassification | undefined;
  /**
   * Hard cap on the response body, enforced while streaming (not just after the full body is
   * buffered) so a misbehaving or compromised provider host can't exhaust process memory with an
   * oversized or content-length-less response. Default 10 MiB comfortably covers every documented
   * JSON error/success body these adapters expect.
   */
  maxBodyBytes?: number;
}

export interface HttpJsonResponse<T> {
  status: number;
  body: T;
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const textDecoder = new TextDecoder();

/** Reads a Response body up to `maxBytes`, throwing before buffering anything larger. */
async function readBodyCapped(
  res: Response,
  providerId: string,
  maxBytes: number,
): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw providerError(
      providerId,
      { errorClass: 'invalid_request', retryable: false },
      `Response body is ${declared} bytes, exceeding the ${maxBytes} byte limit`,
    );
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw providerError(
          providerId,
          { errorClass: 'invalid_request', retryable: false },
          `Response body exceeded the ${maxBytes} byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(combined);
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
  const text = await readBodyCapped(
    res,
    options.providerId,
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  );
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
    // 20.19: out-of-credit wording on a 4xx is an account problem (provider-errors.ts).
    const classification = classifyHttpFailure(
      res.status,
      message,
      options.classifyError?.(res.status, body),
    );
    throw providerError(options.providerId, classification, message, {
      status: res.status,
    });
  }
  return { status: res.status, body: body as T };
}
