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
import { classifyHttpStatus, providerError, type ErrorClassification } from './provider-errors';
import { SyncJobStore } from './sync-jobs';

// BACKLOG 2.4 — Claude for Layers 1–2 (spec 5.2 / 5.3: "Claude Sonnet by default").
// The Messages API is synchronous, so submit() makes the one Claude call and poll() returns
// the parked result. Cost is exact: computed from the response's token usage.

/** Vision input costs about (w/28)×(h/28) tokens; 1600 bounds a ≤1120×1120 image. */
const IMAGE_TOKENS_UPPER_BOUND = 1_600;

export const PROVIDER_ID = 'anthropic';
export const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 16_000;

/** USD per million tokens (Anthropic first-party rates). Add a row before switching models. */
export const MODEL_PRICING_USD_PER_MTOK: Readonly<
  Record<string, { input: number; output: number }>
> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};
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
  model?: string;
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

function classifySdkError(err: unknown): ErrorClassification {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { errorClass: 'timeout', retryable: true };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { errorClass: 'provider_unavailable', retryable: true };
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return classifyHttpStatus(err.status);
  }
  return { errorClass: 'unknown', retryable: false };
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
  private readonly usdToGbpRate: number;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(options: AnthropicAdapterOptions) {
    this.client = options.client;
    this.model = options.model ?? DEFAULT_MODEL;
    if (!MODEL_PRICING_USD_PER_MTOK[this.model]) {
      throw new ConfigurationError(`No pricing configured for Anthropic model ${this.model}`);
    }
    this.usdToGbpRate = options.usdToGbpRate;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /**
   * Upper-bound estimate for the router's budget check: prompt at ~4 chars/token plus the full
   * max_tokens of output. Actual cost (from usage) replaces it at settlement.
   */
  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'text_generation') return 0;
    const price = MODEL_PRICING_USD_PER_MTOK[this.model] ?? { input: 0, output: 0 };
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
    const message = await this.callClaude(request);
    const costPence = usdToPence(computeCostUsd(this.model, message.usage), this.usdToGbpRate);
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
      const { errorClass } = classifySdkError(err);
      return { healthy: false, reason: `${errorClass}: ${(err as Error).message}` };
    }
  }

  private async callClaude(request: TextGenerationRequest): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create({
        model: this.model,
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
      throw providerError(PROVIDER_ID, classifySdkError(err), (err as Error).message);
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
