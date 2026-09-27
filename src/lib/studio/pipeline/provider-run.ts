import { ProviderError } from '../../errors';
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
}

export type ProviderRunDeps = Pick<
  PipelineDeps,
  'registry' | 'breaker' | 'killSwitch' | 'budget' | 'tracking' | 'config' | 'now' | 'sleep'
>;

export async function runProvider(
  input: { need: RouteNeed; request: ProviderRequest; planTier: PlanTier; deadline?: Date },
  deps: ProviderRunDeps,
): Promise<ProviderRunResult> {
  const decision = await routeProvider(
    {
      need: input.need,
      planTier: input.planTier,
      organisationId: input.request.organisationId,
      projectId: input.request.projectId,
      deadline: input.deadline,
      request: input.request,
    },
    {
      registry: deps.registry,
      breaker: deps.breaker,
      killSwitch: deps.killSwitch,
      budget: deps.budget,
      now: deps.now,
    },
  );
  const { adapter } = decision;
  const scope = { organisationId: input.request.organisationId };
  const submitted = await submitTracked(adapter, input.request, deps.tracking);
  const giveUpAt = deps.now() + deps.config.providerTimeoutMs;

  for (;;) {
    const result = await pollTracked(adapter, submitted.jobId, scope, deps.tracking);
    if (result.state === 'succeeded') {
      if (!result.output) {
        throw new ProviderError(
          adapter.providerId,
          'unknown',
          'Provider succeeded without output',
          true,
        );
      }
      return { decision, providerJobRowId: submitted.jobId, output: result.output };
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
      await cancelTracked(adapter, submitted.jobId, scope, deps.tracking);
      deps.breaker.recordFailure(adapter.providerId);
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
