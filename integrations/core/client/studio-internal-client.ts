// PostMind Studio internal API client — for PostMind Core to copy into its codebase.
//
// BACKLOG 14.10. Dependency-free (global fetch, AbortController, setTimeout: Node 18+ or any
// modern runtime). Typed from integrations/core/openapi.json; Studio's CI checks these types
// against the route handlers' zod schemas (test/integrations/core-client-types.test.ts).
//
//   const studio = new StudioInternalClient({
//     baseUrl: process.env.STUDIO_INTERNAL_URL!,        // private ingress, e.g. http://studio.internal
//     serviceToken: process.env.STUDIO_SERVICE_TOKEN!,  // = Studio's STUDIO_INTERNAL_SERVICE_TOKEN
//   });
//   await studio.registerChannel({ organisationId, platform: 'instagram', platformAccountId, ... });
//
// Retries: network errors, timeouts, 429 and 5xx are retried with exponential backoff and full
// jitter (default 5 attempts, 0.5 s base, 30 s cap). A 429's or 503's Retry-After is honoured
// (capped at maxRetryAfterMs). Other 4xx are not retried: they will fail the same way again.
// Idempotency: every Studio internal operation is idempotent server-side (upserts, disconnects of
// an already-disconnected channel, repeat purges), so a retry after a lost response is safe. One
// x-correlation-id is sent on every attempt of a call so Studio's logs tie the attempts together.
// Nothing here logs: pass onRetry to record attempts. Access tokens are never put in errors.

export type MetaPlatform = 'instagram' | 'facebook';
export type ChannelState = 'active' | 'needs_reconnect' | 'revoked';

export interface RegisterChannelInput {
  organisationId: string;
  platform: MetaPlatform;
  /** Numeric Graph id (IG user id / Page id). */
  platformAccountId: string;
  platformAccountName: string;
  /** 16–4096 characters, no whitespace. */
  accessToken: string;
  /** ISO 8601 with offset; null / omitted for Page tokens that do not expire. */
  tokenExpiresAt?: string | null;
  scopes?: string[];
  /** Studio/Core business the account belongs to; omitted = every business in the org. */
  businessId?: string;
  /** The PostMind user who connected the account (for Studio's audit trail). */
  connectedByUserId?: string;
}

export interface RefreshedTokenInput {
  organisationId: string;
  platform: MetaPlatform;
  platformAccountId: string;
  accessToken: string;
  tokenExpiresAt?: string | null;
  scopes?: string[];
}

export interface AccountRef {
  organisationId: string;
  platform: MetaPlatform;
  platformAccountId: string;
}

export interface StudioChannel {
  id: string;
  organisationId: string;
  businessId: string | null;
  platform: string;
  platformAccountId: string;
  platformAccountName: string;
  accessTokenExpiresAt: string | null;
  scopes: string[];
  state: ChannelState;
  connectedAt: string;
}

export interface RefreshResult {
  organisationId: string;
  platform: string;
  platformAccountId: string;
  result: 'updated' | 'not_found' | 'revoked';
  id?: string;
}

export interface PurgeResult {
  organisationId: string;
  channelsWiped: number;
  projectsDeleted: number;
  publicationsCancelled: number;
  requestedAt: string;
  graceUntil: string;
  repeated: boolean;
}

/** Studio's batch limit for POST /internal/tokens/refreshed. */
export const MAX_REFRESH_BATCH = 100;

export interface RetryEvent {
  operation: string;
  attempt: number;
  delayMs: number;
  status?: number;
  error?: string;
  correlationId: string;
}

export interface StudioInternalClientOptions {
  baseUrl: string;
  serviceToken: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Total attempts per call, including the first (default 5). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest Retry-After honoured (default 60 s); longer ones are clamped to it. */
  maxRetryAfterMs?: number;
  /** Per-attempt timeout (default 10 s). */
  timeoutMs?: number;
  onRetry?: (event: RetryEvent) => void;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  correlationId?: () => string;
}

/** A call that failed for good (non-retryable status, or retries exhausted). */
export class StudioInternalError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly details: unknown;
  readonly correlationId: string;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    status: number | null;
    code: string;
    details?: unknown;
    correlationId: string;
    attempts: number;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = 'StudioInternalError';
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.correlationId = input.correlationId;
    this.attempts = input.attempts;
    this.retryable = input.retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Retry-After as milliseconds (delta-seconds or HTTP-date), or null when absent / invalid. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Exponential backoff with full jitter: random(0, min(cap, base * 2^(attempt-1))). */
export function backoffMs(attempt: number, base: number, cap: number, random: () => number) {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

function defaultCorrelationId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `core-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface Envelope {
  ok?: boolean;
  error?: string;
  message?: string;
  details?: unknown;
}

export class StudioInternalClient {
  private readonly options: Required<Omit<StudioInternalClientOptions, 'onRetry' | 'fetch'>> & {
    onRetry?: StudioInternalClientOptions['onRetry'];
    fetch: typeof fetch;
  };

  constructor(options: StudioInternalClientOptions) {
    if (!options.baseUrl) throw new TypeError('baseUrl is required');
    if (!options.serviceToken) throw new TypeError('serviceToken is required');
    this.options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      serviceToken: options.serviceToken,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      maxAttempts: Math.max(1, options.maxAttempts ?? 5),
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 60_000,
      timeoutMs: options.timeoutMs ?? 10_000,
      onRetry: options.onRetry,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      correlationId: options.correlationId ?? defaultCorrelationId,
    };
  }

  /** POST /api/studio/internal/channels — 201 created / 200 updated. */
  async registerChannel(
    input: RegisterChannelInput,
  ): Promise<{ channel: StudioChannel; created: boolean }> {
    return this.request('registerChannel', 'POST', '/api/studio/internal/channels', input);
  }

  /** DELETE /api/studio/internal/channels/:id[?organisationId=] — idempotent. */
  async disconnectChannel(
    id: string,
    options: { organisationId?: string } = {},
  ): Promise<{ disconnected: true; channel: StudioChannel }> {
    const query = options.organisationId
      ? `?${new URLSearchParams({ organisationId: options.organisationId })}`
      : '';
    return this.request(
      'disconnectChannel',
      'DELETE',
      `/api/studio/internal/channels/${encodeURIComponent(id)}${query}`,
    );
  }

  /** DELETE /api/studio/internal/channels?organisationId&platform&platformAccountId — idempotent. */
  async disconnectChannelByAccount(
    ref: AccountRef,
  ): Promise<{ disconnected: true; channel: StudioChannel }> {
    const query = new URLSearchParams({
      organisationId: ref.organisationId,
      platform: ref.platform,
      platformAccountId: ref.platformAccountId,
    });
    return this.request(
      'disconnectChannelByAccount',
      'DELETE',
      `/api/studio/internal/channels?${query}`,
    );
  }

  /** POST /api/studio/internal/tokens/refreshed, one token: 404 unregistered, 409 disconnected. */
  async pushRefreshedToken(input: RefreshedTokenInput): Promise<{ result: RefreshResult }> {
    return this.request(
      'pushRefreshedToken',
      'POST',
      '/api/studio/internal/tokens/refreshed',
      input,
    );
  }

  /**
   * POST /api/studio/internal/tokens/refreshed in batches of MAX_REFRESH_BATCH. Per-channel
   * outcomes; not_found means "register it" and revoked means "the user disconnected it".
   */
  async pushRefreshedTokens(items: RefreshedTokenInput[]): Promise<RefreshResult[]> {
    const results: RefreshResult[] = [];
    for (let i = 0; i < items.length; i += MAX_REFRESH_BATCH) {
      const batch = items.slice(i, i + MAX_REFRESH_BATCH);
      const res = await this.request<{ results: RefreshResult[] }>(
        'pushRefreshedTokens',
        'POST',
        '/api/studio/internal/tokens/refreshed',
        { channels: batch },
      );
      results.push(...res.results);
    }
    return results;
  }

  /** POST /api/studio/internal/organisations/:id/purge — 202, idempotent. */
  async purgeOrganisation(organisationId: string): Promise<{ purge: PurgeResult }> {
    return this.request(
      'purgeOrganisation',
      'POST',
      `/api/studio/internal/organisations/${encodeURIComponent(organisationId)}/purge`,
    );
  }

  private async attempt(
    method: string,
    url: string,
    body: string | undefined,
    correlationId: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await this.options.fetch(url, {
        method,
        headers: {
          'x-service-token': this.options.serviceToken,
          'x-correlation-id': correlationId,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    operation: string,
    method: 'POST' | 'DELETE',
    path: string,
    payload?: unknown,
  ): Promise<T> {
    const url = `${this.options.baseUrl}${path}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const correlationId = this.options.correlationId();
    const { maxAttempts } = this.options;
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      let networkError: string | undefined;
      try {
        response = await this.attempt(method, url, body, correlationId);
      } catch (err) {
        networkError = err instanceof Error ? err.name + ': ' + err.message : 'network error';
      }
      if (response && response.ok) {
        const json = (await response.json()) as T & Envelope;
        const { ok: _ok, ...rest } = json;
        return rest as T;
      }
      const envelope = response ? await readEnvelope(response) : {};
      const status = response?.status ?? null;
      const retryable = status === null || isRetryableStatus(status);
      if (!retryable || attempt >= maxAttempts) {
        throw new StudioInternalError({
          message: `${operation} failed${status ? ` with ${status}` : ''}: ${
            envelope.message ?? envelope.error ?? networkError ?? 'unknown error'
          }`,
          status,
          code: envelope.error ?? (status === null ? 'network_error' : `http_${status}`),
          details: envelope.details,
          correlationId,
          attempts: attempt,
          retryable,
        });
      }
      const retryAfter = response ? parseRetryAfter(response.headers.get('retry-after')) : null;
      const delayMs =
        retryAfter !== null
          ? Math.min(retryAfter, this.options.maxRetryAfterMs)
          : backoffMs(
              attempt,
              this.options.baseDelayMs,
              this.options.maxDelayMs,
              this.options.random,
            );
      this.options.onRetry?.({
        operation,
        attempt,
        delayMs,
        ...(status !== null && { status }),
        ...(networkError && { error: networkError }),
        correlationId,
      });
      await this.options.sleep(delayMs);
    }
  }
}

async function readEnvelope(response: Response): Promise<Envelope> {
  try {
    const json: unknown = await response.json();
    return json && typeof json === 'object' ? (json as Envelope) : {};
  } catch {
    return {};
  }
}
