import {
  NoProviderAvailableError,
  NotImplementedError,
  ProviderError,
  ProvidersUnavailableError,
  RateDeferredError,
  type ProviderAccountFailure,
} from '../../errors';
import { notifierFor } from '../notifications/notifier';
import {
  alertAccountProblem,
  alertProvidersExhausted,
  type AccountAlertDeps,
} from '../providers/account-alerts';
import { isAccountProviderError, retryAtOf } from '../providers/account-errors';
import { LEASE_MARGIN_MS, type ConcurrencySlot } from '../providers/provider-concurrency';
import type { ProviderAdapter, ProviderPollResult, ProviderRequest } from '../providers/interface';
import { waitForNextPoll, type ProviderWake } from '../providers/provider-wake';
import {
  routeProvider,
  type PlanTier,
  type RouteDecision,
  type RouteNeed,
} from '../providers/router';
import {
  cancelTracked,
  pollTracked,
  submitTracked,
  type TrackedSubmission,
} from '../providers/tracked';
import type { PipelineDeps } from './deps';

// One provider operation, end to end: route → tracked submit → poll until terminal. Failures
// become ProviderErrors whose `retryable` flag drives the BullMQ retry decision; on retry the
// router runs again, so an open circuit breaker naturally moves work to the fallback.

export interface ProviderRunResult {
  decision: RouteDecision;
  providerJobRowId: string;
  output: NonNullable<ProviderPollResult['output']>;
  /**
   * 20.20: how to download output.url when the provider requires its credentials for it (Veo);
   * absent = a plain fetch of the (pre-signed) URL.
   */
  fetchOutput?: (url: string) => Promise<Response>;
}

export type ProviderRunDeps = Pick<
  PipelineDeps,
  | 'registry'
  | 'breaker'
  | 'killSwitch'
  | 'budget'
  | 'tracking'
  | 'config'
  | 'now'
  | 'sleep'
  | 'providerRates'
  | 'providerConcurrency'
  | 'providerOverflow'
  | 'providerWake'
  | 'registryFor'
  | 'providerRatings'
  | 'notifier'
  | 'logger'
  | 'fetch'
  | 'db'
>;

export interface RunProviderInput {
  need: RouteNeed;
  request: ProviderRequest;
  planTier: PlanTier;
  deadline?: Date;
  preferredProviderId?: string | readonly string[];
}

/**
 * 20.11: route → run, failing over at once when a provider fails with an ACCOUNT problem (bad
 * key, no credits, usage / spend limit). tracked.ts has already held that provider out of routing
 * (circuit breaker) and the provider_jobs row records its failure; the next candidate for the
 * capability is tried in the same call, with its own provider_jobs row and cost accounting. When
 * no candidate is left, ProvidersUnavailableError (not retried; customers see a friendly
 * "temporarily unavailable" sentence) and one ops alert naming every provider.
 */
export async function runProvider(
  rawInput: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderRunResult> {
  return withFailover(rawInput, deps, (decision, input) => runDecided(decision, input, deps));
}

/**
 * 23.6: a provider job submitted by one queue job and finished by another (asynchronous renders,
 * pipeline/render-async.ts). The 20.29 in-flight slot stays taken until the provider job ends:
 * `lease` names it so the finishing job can give it back (releaseSubmissionSlot).
 */
export interface ProviderSubmission {
  decision: RouteDecision;
  /** studio.provider_jobs.id (tracked: the estimate is reserved, settled when polled). */
  providerJobRowId: string;
  providerJobId: string;
  lease?: { leaseId: string; byoc: boolean };
}

/**
 * 23.6: route → (rate window, in-flight slot) → tracked submit, and return without waiting for the
 * result. Same failover, deferral, kill-switch and cost reservation as runProvider; the caller
 * polls the returned job later (pipeline/render-async.ts) with pollTracked, which settles the cost.
 */
export async function submitProvider(
  rawInput: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderSubmission> {
  return withFailover(rawInput, deps, (decision, input) => submitDecided(decision, input, deps));
}

/** Give back the in-flight slot of a submission whose provider job has ended. */
export async function releaseSubmissionSlot(
  deps: Pick<ProviderRunDeps, 'providerConcurrency' | 'logger'>,
  input: { providerId: string; organisationId: string; lease?: ProviderSubmission['lease'] },
): Promise<void> {
  if (!input.lease || !deps.providerConcurrency?.releaseLease) return;
  try {
    await deps.providerConcurrency.releaseLease({
      providerId: input.providerId,
      organisationId: input.organisationId,
      byoc: input.lease.byoc,
      leaseId: input.lease.leaseId,
    });
  } catch (err) {
    // The lease expires on its own (provider timeout + LEASE_MARGIN_MS).
    deps.logger?.warn({ err, providerId: input.providerId }, 'provider slot release failed');
  }
}

/** Spec 12.5 spend alerts, after a reservation (submit) or a settlement (terminal poll). */
export function recordProviderSpend(
  deps: Pick<ProviderRunDeps, 'budget'>,
  input: { organisationId: string; projectId?: string; planTier: PlanTier; providerId: string },
): Promise<void> {
  return deps.budget.recordSpend?.(input) ?? Promise.resolve();
}

async function withFailover<T>(
  rawInput: RunProviderInput,
  deps: ProviderRunDeps,
  run: (decision: RoutedDecision, input: RunProviderInput) => Promise<T>,
): Promise<T> {
  // 20.23: adapters see the plan tier (Seedance picks its model by it); routing, cost estimates
  // and the submit all use the same request.
  const input: RunProviderInput = {
    ...rawInput,
    request: { ...rawInput.request, planTier: rawInput.planTier },
  };
  const failures: ProviderAccountFailure[] = [];
  // 20.29 overflow (STUDIO_PROVIDER_OVERFLOW=failover): providers found at their in-flight cap in
  // this call, and the first such deferral (thrown when no other provider can take the work).
  const busy: string[] = [];
  let firstDeferral: RateDeferredError | undefined;
  for (;;) {
    let decision: RoutedDecision;
    try {
      decision = await route(input, [...failures.map((f) => f.providerId), ...busy], deps);
    } catch (err) {
      if (err instanceof NoProviderAvailableError && firstDeferral) throw firstDeferral;
      if (err instanceof NoProviderAvailableError && failures.length > 0) {
        const capability = (err.details?.capability as string | undefined) ?? input.need.kind;
        await safely(deps, () =>
          alertProvidersExhausted(alertDeps(deps), { capability, failures }),
        );
        throw new ProvidersUnavailableError(capability, failures);
      }
      throw err;
    }
    try {
      return await run(decision, input);
    } catch (err) {
      if (deps.providerOverflow === 'failover' && isProviderFull(err)) {
        busy.push(decision.providerId);
        firstDeferral ??= err;
        continue;
      }
      if (!isAccountProviderError(err) || err.providerId !== decision.providerId) throw err;
      const failure: ProviderAccountFailure = {
        providerId: decision.providerId,
        errorClass: err.errorClass,
        ...(retryAtOf(err) && { retryAt: retryAtOf(err) }),
      };
      failures.push(failure);
      await safely(deps, () =>
        alertAccountProblem(alertDeps(deps), {
          ...failure,
          message: err.message,
          capability: decision.capability,
        }),
      );
    }
  }
}

/** A deferral because the provider's ACCOUNT is full (not an organisation's fair share). */
function isProviderFull(err: unknown): err is RateDeferredError {
  return err instanceof RateDeferredError && err.details?.reason === 'provider_full';
}

/** Alerting must never change the outcome of the operation it reports on. */
async function safely(deps: ProviderRunDeps, alert: () => Promise<unknown>): Promise<void> {
  try {
    await alert();
  } catch (err) {
    deps.logger?.warn({ err }, 'provider account alert failed');
  }
}

function alertDeps(deps: ProviderRunDeps): AccountAlertDeps {
  return {
    notifier: deps.notifier ?? notifierFor(deps),
    logger: deps.logger,
    now: deps.now,
    fetchImpl: deps.fetch,
  };
}

/** A route decision plus whose account it runs on (20.29 concurrency slots are per account). */
type RoutedDecision = RouteDecision & { accountScope: string };

async function route(
  input: RunProviderInput,
  excludeProviderIds: readonly string[],
  deps: ProviderRunDeps,
): Promise<RoutedDecision> {
  const providerScope = {
    organisationId: input.request.organisationId,
    projectId: input.request.projectId,
  };
  // P1 BYOC: an Enterprise organisation with its own keys routes over its own registry.
  const own = await deps.registryFor?.(providerScope);
  const registry = own ?? deps.registry;
  const accountScope = own ? input.request.organisationId : 'platform';
  // P7: ratings only reorder the tier's candidates; they are advisory, so a failed lookup
  // routes in the spec's order rather than failing the job.
  const providerScores = await deps.providerRatings
    ?.scoresFor(providerScope)
    .catch(() => undefined);
  const decision = await routeProvider(
    {
      need: input.need,
      planTier: input.planTier,
      organisationId: input.request.organisationId,
      projectId: input.request.projectId,
      deadline: input.deadline,
      preferredProviderId: input.preferredProviderId,
      providerScores,
      request: input.request,
      excludeProviderIds,
    },
    {
      registry,
      breaker: deps.breaker,
      killSwitch: deps.killSwitch,
      budget: deps.budget,
      now: deps.now,
    },
  );
  return { ...decision, accountScope };
}

async function runDecided(
  routed: RoutedDecision,
  input: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderRunResult> {
  const decision = withoutScope(routed);
  const slot = await acquireSlots(routed, input, deps);
  try {
    return await submitAndPoll(decision, input, deps);
  } finally {
    await slot?.release();
  }
}

/** 23.6: submit only; the slot stays taken (named by its lease) unless the submit fails. */
async function submitDecided(
  routed: RoutedDecision,
  input: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderSubmission> {
  const decision = withoutScope(routed);
  const slot = await acquireSlots(routed, input, deps);
  let submitted: TrackedSubmission;
  try {
    submitted = await submitTracked(decision.adapter, input.request, deps.tracking);
  } catch (err) {
    await slot?.release();
    throw err;
  }
  await recordProviderSpend(deps, {
    organisationId: input.request.organisationId,
    projectId: input.request.projectId,
    planTier: input.planTier,
    providerId: decision.adapter.providerId,
  });
  return {
    decision,
    providerJobRowId: submitted.jobId,
    providerJobId: submitted.providerJobId,
    ...(slot?.acquired &&
      slot.leaseId && {
        lease: { leaseId: slot.leaseId, byoc: routed.accountScope !== 'platform' },
      }),
  };
}

function withoutScope(routed: RoutedDecision): RouteDecision {
  const { accountScope, ...decision } = routed;
  void accountScope;
  return decision;
}

/**
 * The 15.C3 rate window and the 20.29 in-flight slot for one provider call. Throws
 * RateDeferredError (the job is delayed, no attempt spent) when either is full.
 */
async function acquireSlots(
  routed: RoutedDecision,
  input: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<Extract<ConcurrencySlot, { acquired: true }> | undefined> {
  const { accountScope, adapter } = routed;
  // 15.C3 (spec 11.4): a full rate window delays the job (worker-host moveToDelayed) instead of
  // failing it or spending an attempt.
  if (deps.providerRates) {
    const slot = await deps.providerRates.acquire({
      providerId: adapter.providerId,
      organisationId: input.request.organisationId,
    });
    if (!slot.allowed) throw new RateDeferredError(adapter.providerId, slot.retryAfterMs);
  }
  // 20.29: the provider's account is at its in-flight cap: wait for a slot the same way.
  // An organisation may hold only its share of the platform account's slots (fairness).
  const slot = await deps.providerConcurrency?.acquire({
    providerId: adapter.providerId,
    organisationId: input.request.organisationId,
    byoc: accountScope !== 'platform',
    leaseMs: deps.config.providerTimeoutMs + LEASE_MARGIN_MS,
    // One waiter per shot (or project) and capability, however many times it asks.
    waiterId: `${input.request.shotId ?? input.request.projectId ?? input.request.organisationId}:${input.request.capability}`,
  });
  if (slot && !slot.acquired) {
    // Nothing reaches the provider: give back a half-open trial slot the router may have claimed.
    await deps.breaker.releaseTrial(adapter.providerId);
    throw new RateDeferredError(adapter.providerId, slot.retryAfterMs, { reason: slot.reason });
  }
  return slot;
}

async function submitAndPoll(
  decision: RouteDecision,
  input: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderRunResult> {
  const { adapter } = decision;
  const scope = { organisationId: input.request.organisationId };
  // Spec 12.5 alerts: evaluated after the reservation (submit) and after settlement (terminal).
  const recordSpend = () =>
    deps.budget.recordSpend?.({
      organisationId: input.request.organisationId,
      projectId: input.request.projectId,
      planTier: input.planTier,
      providerId: adapter.providerId,
    }) ?? Promise.resolve();
  const submitted = await submitTracked(adapter, input.request, deps.tracking);
  await recordSpend();
  const giveUpAt = deps.now() + deps.config.providerTimeoutMs;

  for (;;) {
    const result = await pollTracked(adapter, submitted.jobId, scope, deps.tracking);
    if (result.state !== 'running') await recordSpend();
    if (result.state === 'succeeded') {
      if (!result.output) {
        throw new ProviderError(
          adapter.providerId,
          'unknown',
          'Provider succeeded without output',
          true,
        );
      }
      const fetchOutput = adapter.fetchOutput?.bind(adapter);
      return {
        decision,
        providerJobRowId: submitted.jobId,
        output: result.output,
        ...(fetchOutput && { fetchOutput }),
      };
    }
    if (result.state === 'failed') {
      const error = result.error ?? {
        class: 'unknown',
        message: 'Provider failed',
        retryable: true,
      };
      throw new ProviderError(adapter.providerId, error.class, error.message, error.retryable);
    }
    if (deps.now() >= giveUpAt) {
      try {
        await cancelTracked(adapter, submitted.jobId, scope, deps.tracking);
      } catch (err) {
        // Providers without a cancel endpoint (Luma, HeyGen) say so; the job keeps its cost
        // reservation because the provider may still bill it. Anything else is a real failure.
        if (!(err instanceof NotImplementedError)) throw err;
      }
      await deps.breaker.recordFailure(adapter.providerId);
      throw new ProviderError(
        adapter.providerId,
        'timeout',
        `No result after ${Math.round(deps.config.providerTimeoutMs / 1000)}s`,
        true,
      );
    }
    await waitForNextPoll(
      { sleep: deps.sleep, wake: pollWake(adapter, deps) },
      { providerId: adapter.providerId, providerJobId: submitted.providerJobId },
      pollIntervalMs(adapter, deps),
    );
  }
}

/** 23.1: a provider that calls back is woken by the callback; others poll as before. */
function pollWake(adapter: ProviderAdapter, deps: ProviderRunDeps): ProviderWake | undefined {
  return adapter.callbackPollIntervalMs ? deps.providerWake : undefined;
}

/**
 * 23.1: the fallback interval of a provider that calls back (Shotstack 20 s) when this worker can
 * be woken; otherwise the pipeline's poll cadence (5 s).
 */
export function pollIntervalMs(adapter: ProviderAdapter, deps: ProviderRunDeps): number {
  const own = adapter.callbackPollIntervalMs;
  return own && deps.providerWake ? own : deps.config.providerPollIntervalMs;
}

/** Parse the JSON produced by a text_generation provider with a schema. */
export function jsonOutput(output: ProviderRunResult['output']): unknown {
  const metadata = output.metadata as { json?: unknown } | undefined;
  if (metadata?.json === undefined) {
    throw new ProviderError(
      'text_generation',
      'unknown',
      'Provider returned no structured JSON',
      true,
    );
  }
  return metadata.json;
}
