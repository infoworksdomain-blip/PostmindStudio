import { PlatformError, type PlatformErrorClass } from '../../errors';

// JSON-over-HTTP for platform APIs. Non-2xx responses become PlatformErrors; each publisher
// supplies a message extractor and may refine the classification from the platform's own codes.

const DEFAULT_TIMEOUT_MS = 60_000;

/** fetch() wants ArrayBuffer-backed bytes; copy only when a view sits on another buffer type. */
export function asBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

export function classifyPlatformStatus(status: number): {
  errorClass: PlatformErrorClass;
  retryable: boolean;
} {
  if (status === 401) return { errorClass: 'needs_reconnect', retryable: false };
  if (status === 429) return { errorClass: 'rate_limited', retryable: true };
  if (status === 408) return { errorClass: 'timeout', retryable: true };
  if (status >= 500) return { errorClass: 'unavailable', retryable: true };
  return { errorClass: 'invalid_request', retryable: false };
}

export interface PlatformHttpOptions {
  platform: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  /** Pull a readable message (and optional platform error code) out of an error body. */
  describe?: (body: unknown) => { message?: string; code?: string };
  /** Override classification from the platform error code (e.g. quota vs rate limit). */
  refine?: (
    status: number,
    code: string | undefined,
  ) => { errorClass: PlatformErrorClass; retryable: boolean } | undefined;
}

export interface PlatformResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export async function platformRequest<T>(
  url: string,
  init: RequestInit,
  options: PlatformHttpOptions,
): Promise<PlatformResponse<T>> {
  let res: Response;
  try {
    res = await options.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timeout = name === 'TimeoutError' || name === 'AbortError';
    throw new PlatformError(
      options.platform,
      timeout ? 'timeout' : 'unavailable',
      (err as Error).message,
      true,
    );
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
  if (!res.ok && res.status !== 308) {
    const described = options.describe?.(body) ?? {};
    const classification =
      options.refine?.(res.status, described.code) ?? classifyPlatformStatus(res.status);
    throw new PlatformError(
      options.platform,
      classification.errorClass,
      described.message ?? `HTTP ${res.status}`,
      classification.retryable,
      { status: res.status, ...(described.code && { platformCode: described.code }) },
    );
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

/** Poll `check` until it returns a value, sleeping `intervalMs` between tries. */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  opts: {
    intervalMs: number;
    timeoutMs: number;
    platform: string;
    what: string;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<T> {
  const deadline = opts.now() + opts.timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (opts.now() >= deadline) {
      throw new PlatformError(
        opts.platform,
        'timeout',
        `${opts.what} did not finish within ${Math.round(opts.timeoutMs / 1000)}s`,
        true,
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}
