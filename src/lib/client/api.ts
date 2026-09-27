'use client';

import useSWR, { type SWRConfiguration } from 'swr';

// BACKLOG 10.2 — browser → /api/studio. Auth rides on PostMind's session cookie (same-origin
// requests; tenant.ts verifies it), so no token is ever handled in JavaScript. Errors keep the
// API's `{ ok: false, error, message, details }` envelope as an ApiError.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export function apiPath(path: string, query?: Query): string {
  const base = path.startsWith('/api/')
    ? path
    : `/api/studio${path.startsWith('/') ? '' : '/'}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Sent as Idempotency-Key so a retried create never runs twice (spec 8.1). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (request.body instanceof FormData) {
    body = request.body;
  } else if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(request.body);
  }
  if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
  const res = await fetch(apiPath(path, request.query), {
    method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    credentials: 'same-origin',
    signal: request.signal,
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON (proxy error page)
  }
  if (!res.ok) {
    const envelope = (json ?? {}) as {
      error?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
    throw new ApiError(
      res.status,
      envelope.error ?? `http_${res.status}`,
      envelope.message ?? `Request failed (${res.status})`,
      envelope.details,
    );
  }
  return json as T;
}

/** SWR-backed GET. Pass null to skip (e.g. until a dependency is known). */
export function useApi<T>(
  path: string | null,
  query?: Query,
  config?: SWRConfiguration<T, ApiError>,
) {
  const key = path ? apiPath(path, query) : null;
  return useSWR<T, ApiError>(key, (url: string) => api<T>(url), {
    revalidateOnFocus: false,
    ...config,
  });
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A user-facing sentence for any error thrown by api(). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your PostMind session has expired. Sign in again.';
    if (err.status === 403) return 'You don’t have permission to do that.';
    if (err.status === 429) return 'Too many requests — try again in a moment.';
    const problems = err.details?.problems;
    if (Array.isArray(problems) && problems.length) return `${err.message}: ${problems.join('; ')}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
