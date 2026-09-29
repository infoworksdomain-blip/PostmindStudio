'use client';

import { useLocale, useMessages } from 'next-intl';
import { useCallback } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import type { Messages } from '@/lib/i18n/messages';
import { emitUpgrade, isUpgradeCode } from './upgrade-events';

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
    const error = new ApiError(
      res.status,
      envelope.error ?? `http_${res.status}`,
      envelope.message ?? `Request failed (${res.status})`,
      envelope.details,
    );
    // Phase 18: plan / billing blocks also open the global upgrade dialog.
    if (isUpgradeCode(error.code))
      emitUpgrade({
        code: error.code,
        status: error.status,
        message: error.message,
        details: error.details,
      });
    throw error;
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

// BACKLOG 16.1 — API errors in the reader's language. The server writes English messages, so an
// English locale keeps the server's (more specific) sentence as before; other locales show the
// catalogue sentence for the error code (messages/<locale>.json → errors.codes.<code>), falling
// back to the server message when the code has no entry. 401 / 403 / 429 are always the catalogue's.

export type ErrorCatalogue = Messages['errors'];

export interface ErrorLocale {
  locale: string;
  errors: ErrorCatalogue;
}

/** Fallback when no catalogue is registered (a plain unit test, or before the provider renders). */
const ENGLISH: ErrorCatalogue = {
  generic: 'Something went wrong.',
  sessionExpired: 'Your PostMind session has expired. Sign in again.',
  forbidden: 'You don’t have permission to do that.',
  rateLimited: 'Too many requests — try again in a moment.',
  withProblems: '{message}: {problems}',
  requestFailed: 'Request failed ({status})',
  codes: {} as ErrorCatalogue['codes'],
};

let activeCatalogue: ErrorLocale | null = null;

/**
 * StudioIntlProvider registers the active locale's `errors` namespace so plain calls such as
 * `toast.error(errorMessage(err))` outside a component body are translated too.
 */
export function registerErrorCatalogue(locale: string, errors: ErrorCatalogue): void {
  if (activeCatalogue?.locale === locale && activeCatalogue.errors === errors) return;
  activeCatalogue = { locale, errors };
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

function codeMessage(errors: ErrorCatalogue, code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(errors.codes, code)
    ? errors.codes[code as keyof ErrorCatalogue['codes']]
    : undefined;
}

/** A user-facing sentence for any error thrown by api(), in the active (or given) locale. */
export function errorMessage(err: unknown, target: ErrorLocale | null = activeCatalogue): string {
  const errors = target?.errors ?? ENGLISH;
  const english = !target || target.locale.toLowerCase().startsWith('en');
  if (err instanceof ApiError) {
    if (err.status === 401) return errors.sessionExpired;
    // 15.D2 / P3: plan gates and quotas carry their own upgrade message.
    if (err.status === 403 && (err.code === 'plan_tier' || err.code === 'quota_exceeded'))
      return english ? err.message : (codeMessage(errors, err.code) ?? err.message);
    if (err.status === 403) return errors.forbidden;
    if (err.status === 429) return errors.rateLimited;
    if (!english) {
      const byCode = codeMessage(errors, err.code);
      if (byCode) return byCode;
      if (/^http_\d{3}$/.test(err.code)) return fill(errors.requestFailed, { status: err.status });
      return err.message;
    }
    const problems = err.details?.problems;
    if (Array.isArray(problems) && problems.length)
      return fill(errors.withProblems, { message: err.message, problems: problems.join('; ') });
    return err.message;
  }
  // Errors thrown in the browser carry English text; other locales get the generic sentence.
  return err instanceof Error && english ? err.message : errors.generic;
}

/** Hook form of errorMessage bound to the nearest StudioIntlProvider's locale. */
export function useErrorMessage(): (err: unknown) => string {
  const locale = useLocale();
  const messages = useMessages() as Messages;
  const errors = messages.errors;
  return useCallback((err: unknown) => errorMessage(err, { locale, errors }), [locale, errors]);
}
