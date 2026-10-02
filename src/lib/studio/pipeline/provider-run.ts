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
import type { ProviderPollResult, ProviderRequest } from '../providers/interface';
import {
  routeProvider,
  type PlanTier,
  type RouteDecision,
  type RouteNeed,
} from '../providers/router';
import { cancelTracked, pollTracked, submitTracked } from '../providers/tracked';
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
  input: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderRunResult> {
  const failures: ProviderAccountFailure[] = [];
  for (;;) {
    let decision: RouteDecision;
    try {
      decision = await route(
        input,
        failures.map((f) => f.providerId),
        deps,
      );
    } catch (err) {
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
      return await runDecided(decision, input, deps);
    } catch (err) {
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

async function route(
  input: RunProviderInput,
  excludeProviderIds: readonly string[],
  deps: ProviderRunDeps,
): Promise<RouteDecision> {
  const providerScope = {
    organisationId: input.request.organisationId,
    projectId: input.request.projectId,
  };
  // P1 BYOC: an Enterprise organisation with its own keys routes over its own registry.
  const registry = (await deps.registryFor?.(providerScope)) ?? deps.registry;
  // P7: ratings only reorder the tier's candidates; they are advisory, so a failed lookup
  // routes in the spec's order rather than failing the job.
  const providerScores = await deps.providerRatings
    ?.scoresFor(providerScope)
    .catch(() => undefined);
  return routeProvider(
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
}

async function runDecided(
  decision: RouteDecision,
  input: RunProviderInput,
  deps: ProviderRunDeps,
): Promise<ProviderRunResult> {
  const { adapter } = decision;
  // 15.C3 (spec 11.4): a full rate window delays the job (worker-host moveToDelayed) instead of
  // failing it or spending an attempt.
  if (deps.providerRates) {
    const slot = await deps.providerRates.acquire({
      providerId: adapter.providerId,
      organisationId: input.request.organisationId,
    });
    if (!slot.allowed) throw new RateDeferredError(adapter.providerId, slot.retryAfterMs);
  }
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
    await deps.sleep(deps.config.providerPollIntervalMs);
  }
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
