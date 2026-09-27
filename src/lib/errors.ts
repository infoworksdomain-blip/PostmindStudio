// Custom error classes (BACKLOG 1.2). Production code never throws a plain `Error`.
// Every StudioError maps to an HTTP status and the Engagement error envelope
// `{ ok: false, error, details? }` (Engagement handover Section 14.1).

export type KillSwitchLevel = 'global' | 'workspace' | 'project' | 'provider';

export abstract class StudioError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class UnauthorizedError extends StudioError {
  readonly status = 401;
  readonly code = 'unauthorized';
}

export class ForbiddenError extends StudioError {
  readonly status = 403;
  readonly code = 'forbidden';
}

export class NotFoundError extends StudioError {
  readonly status = 404;
  readonly code = 'not_found';
}

export class ValidationError extends StudioError {
  readonly status = 400;
  readonly code = 'validation_error';
}

export class RateLimitError extends StudioError {
  readonly status = 429;
  readonly code = 'rate_limited';
  readonly retryAfterSec: number;

  constructor(message: string, retryAfterSec: number, details?: Record<string, unknown>) {
    super(message, details);
    this.retryAfterSec = retryAfterSec;
  }
}

export class KillSwitchTriggeredError extends StudioError {
  readonly status = 503;
  readonly code = 'kill_switch_active';
  readonly level: KillSwitchLevel;

  constructor(level: KillSwitchLevel, message: string, details?: Record<string, unknown>) {
    super(message, { ...details, level });
    this.level = level;
  }
}

export class ProviderError extends StudioError {
  readonly status = 502;
  readonly code = 'provider_error';
  readonly providerId: string;
  readonly errorClass: string;
  readonly retryable: boolean;

  constructor(
    providerId: string,
    errorClass: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ) {
    super(message, { ...details, providerId, errorClass, retryable });
    this.providerId = providerId;
    this.errorClass = errorClass;
    this.retryable = retryable;
  }
}

/** A PostMind Core / Engagement dependency failed or returned an unexpected shape. */
export class UpstreamServiceError extends StudioError {
  readonly status = 502;
  readonly code = 'upstream_error';
}

/** Required configuration (usually an env var) is missing or malformed. */
export class ConfigurationError extends StudioError {
  readonly status = 500;
  readonly code = 'configuration_error';
}

/** An integration point that is deliberately not built yet (CLAUDE.md rule 4). */
export class NotImplementedError extends StudioError {
  readonly status = 501;
  readonly code = 'not_implemented';
}

const INTERNAL_ERROR_BODY = { ok: false, error: 'internal_error' } as const;

/** Convert any thrown value into the Engagement-style JSON error response. */
export function toErrorResponse(err: unknown): Response {
  if (!(err instanceof StudioError)) {
    return Response.json(INTERNAL_ERROR_BODY, { status: 500 });
  }
  // Configuration problems are server-side; never leak their detail to callers.
  if (err instanceof ConfigurationError) {
    return Response.json(INTERNAL_ERROR_BODY, { status: 500 });
  }
  const headers: Record<string, string> = {};
  if (err instanceof RateLimitError) headers['Retry-After'] = String(err.retryAfterSec);
  return Response.json(
    {
      ok: false,
      error: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    },
    { status: err.status, headers },
  );
}
