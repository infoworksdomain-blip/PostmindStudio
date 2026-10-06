import Anthropic from '@anthropic-ai/sdk';
import { ConfigurationError, ProviderError } from '../../errors';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
  TextGenerationRequest,
} from './interface';
import { usdToPence } from './pricing';
import { parseRegainAt } from './account-errors';
import { classifyHttpStatus, providerError, type ErrorClassification } from './provider-errors';
import { SyncJobStore } from './sync-jobs';
import { DEFAULT_MODEL, hasModelPricing, MODEL_PRICING_USD_PER_MTOK } from './anthropic-models';
import {
  DEFAULT_LIGHT_MODEL,
  modelForTask,
  modelsOf,
  type TextModelMap,
  type TextTask,
} from './text-tasks';

// BACKLOG 2.4 — Claude for Layers 1–2 (spec 5.2 / 5.3: "Claude Sonnet by default").
// The Messages API is synchronous, so submit() makes the one Claude call and poll() returns
// the parked result. Cost is exact: computed from the response's token usage.
// 23.2: the model is chosen per call from the request's task (text-tasks.ts): light tasks run on
// Claude Haiku 4.5 by default, and cost is priced at the model that actually ran.

/** Vision input costs about (w/28)×(h/28) tokens; 1600 bounds a ≤1120×1120 image. */
const IMAGE_TOKENS_UPPER_BOUND = 1_600;

export const PROVIDER_ID = 'anthropic';
export { DEFAULT_MODEL, MODEL_PRICING_USD_PER_MTOK };
const DEFAULT_MAX_TOKENS = 16_000;

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** The subset of the SDK client the adapter uses (lets tests inject recorded responses). */
export interface AnthropicClientLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
  models: { retrieve(modelId: string): Promise<unknown> };
}

export interface AnthropicAdapterOptions {
  client: AnthropicClientLike;
  /** The standard-tier model (ANTHROPIC_MODEL); default DEFAULT_MODEL. */
  model?: string;
  /** 23.2: the light-tier model (ANTHROPIC_LIGHT_MODEL); default Claude Haiku 4.5. */
  lightModel?: string;
  /** 23.2: per-task overrides (ANTHROPIC_TASK_MODELS). */
  taskModels?: TextModelMap['overrides'];
  usdToGbpRate: number;
  now?: () => number;
}

export function computeCostUsd(model: string, usage: Anthropic.Usage): number {
  const price = MODEL_PRICING_USD_PER_MTOK[model];
  if (!price) throw new ConfigurationError(`No pricing configured for Anthropic model ${model}`);
  const inputTokens =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE_MULTIPLIER +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ_MULTIPLIER;
  return (inputTokens * price.input + usage.output_tokens * price.output) / 1_000_000;
}

interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string; details?: { error_code?: string } };
  request_id?: string;
}

/** What an Anthropic error means for Studio, plus the readable message and any resume time. */
export interface AnthropicErrorInfo extends ErrorClassification {
  message?: string;
  /** ISO time the provider says access resumes (spend limits / caps). */
  retryAt?: string;
}

// 20.11 — documented account-level errors (read 2026-09-30):
//   https://platform.claude.com/docs/en/api/errors
//     401 authentication_error (key malformed, revoked, expired) → auth
//     402 billing_error ("an issue with your billing or payment information") → insufficient_credits
//     403 permission_error → auth
//     400 invalid_request_error is "also returned … when usage reaches an organization or
//         workspace spend limit you set"
//     429 rate_limit_error covers rate limits AND the usage tier's monthly spend cap
//   https://platform.claude.com/docs/en/api/rate-limits
//     "Setting your own spend limit": 400 invalid_request_error whose message "begins `You have
//       reached your specified API usage limits`, or `You have reached your specified workspace
//       API usage limits` for a workspace limit, and states when access resumes" → account_limit
//     "Reaching your spend cap": 429 rate_limit_error with error.details.error_code
//       "enforced_spend_limit_reached" (no retry-after; "keeps failing until access resumes"),
//       message "… You will regain access on 2026-09-01 at 00:00 UTC." → account_limit
const SPEND_LIMIT_MESSAGE = /^You have reached your specified (?:workspace )?API usage limits/i;
const SPEND_CAP_CODE = 'enforced_spend_limit_reached';

export function classifyAnthropicError(status: number, body: unknown): AnthropicErrorInfo {
  const error = (body as AnthropicErrorBody | undefined)?.error;
  const message = typeof error?.message === 'string' ? error.message : undefined;
  const regain = message ? parseRegainAt(message) : undefined;
  const limit = (): AnthropicErrorInfo => ({
    errorClass: 'account_limit',
    retryable: false,
    message,
    ...(regain && { retryAt: regain.toISOString() }),
  });
  if (status === 400 && message && SPEND_LIMIT_MESSAGE.test(message)) return limit();
  if (status === 429 && error?.details?.error_code === SPEND_CAP_CODE) return limit();
  if (status === 402 || error?.type === 'billing_error') {
    return { errorClass: 'insufficient_credits', retryable: false, message };
  }
  return { ...classifyHttpStatus(status), message };
}

function classifySdkError(err: unknown): AnthropicErrorInfo {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { errorClass: 'timeout', retryable: true };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { errorClass: 'provider_unavailable', retryable: true };
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return classifyAnthropicError(err.status, err.error);
  }
  return { errorClass: 'unknown', retryable: false };
}

/** A readable message: the API's own `error.message`, never the raw JSON body. */
function sdkErrorMessage(err: unknown, info: AnthropicErrorInfo): string {
  if (info.message) {
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    return status ? `${status} ${info.message}` : info.message;
  }
  return (err as Error).message;
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['text_generation'];

  private readonly client: AnthropicClientLike;
  private readonly model: string;
  private readonly models: TextModelMap;
  private readonly usdToGbpRate: number;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(options: AnthropicAdapterOptions) {
    this.client = options.client;
    this.model = options.model ?? DEFAULT_MODEL;
    this.models = {
      standard: this.model,
      light: options.lightModel ?? DEFAULT_LIGHT_MODEL,
      overrides: options.taskModels ?? {},
    };
    for (const model of modelsOf(this.models)) {
      if (!hasModelPricing(model)) {
        throw new ConfigurationError(`No pricing configured for Anthropic model ${model}`);
      }
    }
    this.usdToGbpRate = options.usdToGbpRate;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /** 23.2: the model a request runs on (its task's tier, or the standard model). */
  modelFor(request: { task?: TextTask }): string {
    return modelForTask(this.models, request.task);
  }

  /**
   * Upper-bound estimate for the router's budget check: prompt at ~4 chars/token plus the full
   * max_tokens of output. Actual cost (from usage) replaces it at settlement.
   */
  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'text_generation') return 0;
    const price = MODEL_PRICING_USD_PER_MTOK[this.modelFor(request)] ?? { input: 0, output: 0 };
    const inputTokens =
      Math.ceil((request.system.length + request.prompt.length) / 4) +
      (request.images?.length ?? 0) * IMAGE_TOKENS_UPPER_BOUND;
    const outputTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    return usdToPence(
      (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
      this.usdToGbpRate,
    );
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'text_generation') {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Anthropic adapter does not support ${request.capability}`,
      );
    }
    const model = this.modelFor(request);
    const message = await this.callClaude(request, model);
    const costPence = usdToPence(computeCostUsd(model, message.usage), this.usdToGbpRate);
    const result = this.toPollResult(message, request, costPence);
    return {
      providerJobId: this.results.put(result),
      estimatedCostPence: costPence,
      estimatedReadyAt: new Date(this.now()),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    return this.results.get(providerJobId);
  }

  /** Nothing is in flight after submit() returns; cancelling just discards the result. */
  async cancel(providerJobId: string): Promise<void> {
    this.results.delete(providerJobId);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.client.models.retrieve(this.model);
      return { healthy: true };
    } catch (err) {
      const info = classifySdkError(err);
      return { healthy: false, reason: `${info.errorClass}: ${sdkErrorMessage(err, info)}` };
    }
  }

  private async callClaude(
    request: TextGenerationRequest,
    model: string,
  ): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create({
        model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: [
          {
            role: 'user',
            content: request.images?.length
              ? [
                  ...request.images.map((image) => ({
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: image.mediaType,
                      data: image.data,
                    },
                  })),
                  { type: 'text' as const, text: request.prompt },
                ]
              : request.prompt,
          },
        ],
        ...(request.outputSchema && {
          output_config: { format: { type: 'json_schema', schema: request.outputSchema } },
        }),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const info = classifySdkError(err);
      const requestId = err instanceof Anthropic.APIError ? err.requestID : undefined;
      throw providerError(
        PROVIDER_ID,
        { errorClass: info.errorClass, retryable: info.retryable },
        sdkErrorMessage(err, info),
        {
          ...(err instanceof Anthropic.APIError && err.status && { status: err.status }),
          ...(requestId && { requestId }),
          ...(info.retryAt && { retryAt: info.retryAt }),
        },
      );
    }
  }

  private toPollResult(
    message: Anthropic.Message,
    request: TextGenerationRequest,
    costPence: number,
  ): ProviderPollResult {
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
    if (message.stop_reason === 'refusal') {
      return {
        state: 'failed',
        error: {
          class: 'content_policy',
          message: 'Claude declined the request',
          retryable: false,
        },
      };
    }
    if (message.stop_reason === 'max_tokens') {
      return {
        state: 'failed',
        error: {
          class: 'output_truncated',
          message: `Output hit max_tokens (${request.maxTokens ?? DEFAULT_MAX_TOKENS})`,
          retryable: false,
        },
      };
    }
    const text = extractText(message);
    const metadata: Record<string, unknown> = {
      model: message.model,
      messageId: message.id,
      text,
      usage,
      costPence,
    };
    if (request.outputSchema) {
      try {
        metadata.json = JSON.parse(text) as unknown;
      } catch {
        return {
          state: 'failed',
          error: {
            class: 'unknown',
            message: 'Structured output was not valid JSON',
            retryable: true,
          },
        };
      }
    }
    return { state: 'succeeded', output: { metadata } };
  }
}
