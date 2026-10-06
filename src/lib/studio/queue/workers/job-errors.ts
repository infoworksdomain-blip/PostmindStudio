import {
  ConfigurationError,
  CostCapPausedError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  NotFoundError,
  NotImplementedError,
  PlatformError,
  ProviderError,
  ProvidersUnavailableError,
  StudioError,
  ValidationError,
} from '../../../errors';
import { isAccountErrorClass } from '../../providers/account-errors';

// BACKLOG 3.9 error classification, shared by the job wrapper (runtime.ts) and by work that
// finishes outside the job that started it (23.6 asynchronous renders, pipeline/render-async.ts).

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError || err instanceof PlatformError) return err.retryable;
  // 20.11: every provider lost to an account problem; the operator must fix an account (alerted).
  if (err instanceof ProvidersUnavailableError) return false;
  // Breakers close and budgets reset; routing again later may succeed.
  if (err instanceof NoProviderAvailableError) return true;
  if (
    err instanceof KillSwitchTriggeredError ||
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof NotImplementedError ||
    err instanceof ConfigurationError
  ) {
    return false;
  }
  if (err instanceof StudioError) return false;
  return true; // unexpected errors (DB blips, network) are worth retrying
}

/** A routing failure caused only by budgets (a customer's cap), not by provider availability. */
function budgetOnly(err: NoProviderAvailableError): boolean {
  const candidates = err.details?.candidates;
  if (!Array.isArray(candidates)) return false;
  const reasons = candidates
    .map((c) => (c as { skipped?: string }).skipped)
    .filter((r) => r !== undefined && r !== 'not_configured' && r !== 'capability_unsupported');
  return reasons.length > 0 && reasons.every((r) => r === 'over_budget');
}

export function describeError(err: unknown): string {
  if (err instanceof KillSwitchTriggeredError) return `kill_switch_${err.level}: ${err.message}`;
  if (err instanceof CostCapPausedError) return `cost_cap_paused: ${err.message}`;
  // 20.11: stored reasons are shown to customers (as a translated sentence by code); no provider
  // text for account problems, which stays in logs and provider_jobs.
  if (err instanceof NoProviderAvailableError && !budgetOnly(err)) {
    return `service_unavailable: ${err.message}`;
  }
  if (err instanceof ProviderError) {
    return isAccountErrorClass(err.errorClass)
      ? `service_unavailable: ${err.providerId}/${err.errorClass}`
      : `${err.providerId}/${err.errorClass}: ${err.message}`;
  }
  if (err instanceof PlatformError) return `${err.platform}/${err.errorClass}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
