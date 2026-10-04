// Custom error classes (BACKLOG 1.2). Production code never throws a plain `Error`.
// Every StudioError maps to an HTTP status and the Engagement error envelope
// `{ ok: false, error, details? }` (Engagement handover Section 14.1).

export type KillSwitchLevel = 'global' | 'workspace' | 'project' | 'provider' | 'platform';

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

/** 15.D1 / A12.4: a switchable feature is off (globally, for the organisation or the env). */
export class FeatureDisabledError extends StudioError {
  readonly status = 403;
  readonly code = 'feature_disabled';
  readonly feature: string;

  constructor(feature: string, message: string, details?: Record<string, unknown>) {
    super(message, { ...details, feature });
    this.feature = feature;
  }
}

/** 15.D2 / A10.3: the organisation's plan tier is below what the capability needs. */
export class PlanTierError extends StudioError {
  readonly status = 403;
  readonly code = 'plan_tier';
  readonly requiredTier: string;

  constructor(requiredTier: string, message: string, details?: Record<string, unknown>) {
    super(message, { ...details, requiredTier });
    this.requiredTier = requiredTier;
  }
}

/**
 * Phase 18 §P.3: the organisation has no plan (never subscribed, or checkout unfinished), so
 * generate / publish / scan are refused. The UI opens the upgrade dialog.
 */
export class PlanRequiredError extends StudioError {
  readonly status = 402;
  readonly code = 'plan_required';
}

/**
 * Phase 18 §P.3: the organisation's billing is read-only (payment failed past the grace period,
 * unpaid or cancelled after a paid period). Mutations outside the allowlist are refused.
 */
export class BillingRequiredError extends StudioError {
  readonly status = 402;
  readonly code = 'billing_required';
}

/** Phase 18 §2.2: the signed-in user has no (active) organisation yet; the UI routes to onboarding. */
export class NoOrganisationError extends StudioError {
  readonly status = 403;
  readonly code = 'no_organisation';
}

/** Decision P3 / spec 12.4: the plan's monthly quota (or a per-video limit) is used up. */
export class QuotaExceededError extends StudioError {
  readonly status = 403;
  readonly code = 'quota_exceeded';
}

/**
 * 21.5: the organisation publishes to more platforms than the channels it pays for; this one is
 * past the limit. The UI shows "add a channel" (upgrade dialog), not a failure. details:
 * { channels, platform, allowedPlatforms }.
 */
export class ChannelLimitError extends StudioError {
  readonly status = 403;
  readonly code = 'channel_limit';
}

export class NotFoundError extends StudioError {
  readonly status = 404;
  readonly code = 'not_found';
}

/** The request conflicts with the resource's current state (e.g. generating an active project). */
export class ConflictError extends StudioError {
  readonly status = 409;
  readonly code = 'conflict';
}

export class ValidationError extends StudioError {
  readonly status = 400;
  readonly code = 'validation_error';
}

/**
 * 20.12: auto-publish or a schedule was asked for, but no connected social account was given to
 * post to. "Platforms" are the formats Studio renders; "accounts" are the connections it posts to.
 */
export class AutoPublishAccountRequiredError extends StudioError {
  readonly status = 400;
  readonly code = 'auto_publish_account_required';
}

/** 20.12: a chosen account is not a usable connection of this organisation and platform. */
export class AutoPublishAccountUnavailableError extends StudioError {
  readonly status = 400;
  readonly code = 'auto_publish_account_unavailable';
}

/** 15.C4: well-formed but not allowed for this organisation (e.g. a tier above its plan). */
export class UnprocessableError extends StudioError {
  readonly status = 422;
  readonly code = 'unprocessable';
}

/**
 * 15.C3 (spec 11.4): the provider's rate window for this organisation (or platform-wide) is
 * full. Workers delay the job until the window frees instead of failing it; no attempt is used.
 */
export class RateDeferredError extends StudioError {
  readonly status = 429;
  readonly code = 'rate_deferred';
  readonly providerId: string;
  readonly retryAfterMs: number;

  constructor(providerId: string, retryAfterMs: number, details?: Record<string, unknown>) {
    super(`${providerId} rate window is full; retry in ${Math.ceil(retryAfterMs / 1000)}s`, {
      ...details,
      providerId,
      retryAfterMs,
    });
    this.providerId = providerId;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request body is larger than the endpoint accepts. */
export class PayloadTooLargeError extends StudioError {
  readonly status = 413;
  readonly code = 'payload_too_large';
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

export type PlatformErrorClass =
  | 'needs_reconnect' // credentials revoked/expired and refresh failed: user must reconnect
  | 'rate_limited'
  | 'quota_exceeded'
  | 'content_policy'
  | 'invalid_media' // format/duration/aspect rejected: re-render, don't retry as-is
  | 'invalid_request'
  | 'unavailable'
  | 'timeout'
  /** A previous upload started but its result was never recorded: it may be live. */
  | 'outcome_unknown'
  | 'unknown';

/** A social platform (TikTok, YouTube, X, LinkedIn, Instagram, Facebook) rejected or failed a call. */
export class PlatformError extends StudioError {
  readonly status = 502;
  readonly code = 'platform_error';
  readonly platform: string;
  readonly errorClass: PlatformErrorClass;
  readonly retryable: boolean;

  constructor(
    platform: string,
    errorClass: PlatformErrorClass,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ) {
    super(message, { ...details, platform, errorClass, retryable });
    this.platform = platform;
    this.errorClass = errorClass;
    this.retryable = retryable;
  }
}

/**
 * Phase 18 §2.10: the Meta login finished but granted no Facebook Page (or Instagram account
 * linked to one) that the user can publish to, so nothing was connected.
 */
export class MetaNoAccountsError extends StudioError {
  readonly status = 422;
  readonly code = 'meta_no_accounts';
}

/** Spec 6.4 NO_PROVIDER_AVAILABLE: every routing candidate was skipped. */
export class NoProviderAvailableError extends StudioError {
  readonly status = 503;
  readonly code: 'no_provider_available' | 'service_unavailable' = 'no_provider_available';
}

export type CostCapScope = 'project' | 'org_daily' | 'org_monthly' | 'global_daily';

/**
 * Spec 12.5 — generation is paused by a cost cap: the project reached 90% of costBudgetPence,
 * or the organisation's daily / monthly or the platform's daily cap is spent. Not retryable: the
 * cap has to be raised (or the day / month roll over) and the project regenerated.
 */
export class CostCapPausedError extends StudioError {
  readonly status = 409;
  readonly code = 'cost_cap_paused';
  readonly scope: CostCapScope;

  constructor(scope: CostCapScope, message: string, details?: Record<string, unknown>) {
    super(message, { ...details, scope });
    this.scope = scope;
  }
}

/**
 * QA 3: the job queue (Redis) could not take a job. Nothing was posted and nothing was kept, so
 * the same request can simply be sent again (502, translated errors.codes.queue_unavailable).
 */
export class QueueUnavailableError extends StudioError {
  readonly status = 502;
  readonly code = 'queue_unavailable';
}

/** A PostMind Core / Engagement dependency failed or returned an unexpected shape. */
export class UpstreamServiceError extends StudioError {
  readonly status = 502;
  readonly code = 'upstream_error';
}

/** Required configuration (usually an env var) is missing or malformed. */
/** 20.11: one provider that failed a routed operation with an account problem. */
export interface ProviderAccountFailure {
  providerId: string;
  /** auth | insufficient_credits | account_limit */
  errorClass: string;
  /** ISO time the provider said access resumes, if it did. */
  retryAt?: string;
}

/**
 * 20.11: every provider for the capability failed with an account problem (bad key, no credits,
 * usage limit) or is held out of routing for one. Not retryable within the job: the operator has
 * to fix the account (they are alerted). Customers see a friendly "temporarily unavailable"
 * sentence; the provider names and classes stay in logs, provider_jobs and the Admin Centre.
 */
export class ProvidersUnavailableError extends NoProviderAvailableError {
  // A NoProviderAvailableError, so callers that degrade gracefully without a provider (captions,
  // content safety, library ingest) keep doing so.
  override readonly code = 'service_unavailable' as const;
  readonly capability: string;
  readonly failures: readonly ProviderAccountFailure[];

  constructor(capability: string, failures: readonly ProviderAccountFailure[]) {
    const summary = failures
      .map((f) => `${f.providerId}/${f.errorClass}${f.retryAt ? ` until ${f.retryAt}` : ''}`)
      .join(', ');
    super(`Every ${capability} provider is unavailable: ${summary}`, {
      capability,
      failures: failures.map((f) => ({ ...f })),
    });
    this.capability = capability;
    this.failures = failures;
  }
}

/** Customer-safe English sentences for provider failures (the UI translates by code). */
export const PROVIDER_ERROR_SENTENCE =
  'A generation provider had a problem. Try again in a moment.';
export const SERVICE_UNAVAILABLE_SENTENCE =
  'Our AI service is temporarily unavailable. Please try again later. Our team has been alerted.';

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
  // 20.11: never pass a provider's own text (or raw JSON body) to a caller; it stays in logs and
  // provider_jobs. The client shows the catalogue sentence for the code.
  if (err instanceof ProvidersUnavailableError) {
    return Response.json(
      { ok: false, error: err.code, message: SERVICE_UNAVAILABLE_SENTENCE },
      { status: err.status },
    );
  }
  if (err instanceof ProviderError) {
    return Response.json(
      {
        ok: false,
        error: err.code,
        message: PROVIDER_ERROR_SENTENCE,
        details: {
          providerId: err.providerId,
          errorClass: err.errorClass,
          retryable: err.retryable,
        },
      },
      { status: err.status },
    );
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
