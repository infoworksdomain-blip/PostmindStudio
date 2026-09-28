import OpenAI from 'openai';
import { ConfigurationError, ProviderError } from '../../errors';
import { providerOutputKey, type AssetStorage } from '../storage';
import type {
  AspectRatio,
  EmbeddingRequest,
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
  TextToImageRequest,
} from './interface';
import { usdToPence } from './pricing';
import {
  DEFAULT_TEXT_MODEL,
  estimateTextPence,
  generateText,
  TEXT_PRICING,
  transcribe,
  transcriptionPence,
  type OpenAITextClient,
} from './openai-text';
import { classifyHttpStatus, providerError, type ErrorClassification } from './provider-errors';
import { SyncJobStore } from './sync-jobs';

// BACKLOG 2.5 — OpenAI images (Layer 3 IMAGE_STILL) + embeddings (library / image search).
// 15.C1 — text generation (Layers 1–2 fallback) and transcription (captions fallback), in
// openai-text.ts.
//
// SPEC DRIFT: the spec names DALL-E 3, which OpenAI removed from the API on 2026-05-12
// (developers.openai.com/api/docs/deprecations). The default image model is gpt-image-2, the
// replacement named on that page. GPT image models return base64 only, so images are
// written to S3 and the adapter returns a signed URL.
//
// Every endpoint is synchronous; submit() does the work and poll() returns the parked result.

export const PROVIDER_ID = 'openai';
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_MAX_INPUTS = 2048;

// USD per 1M tokens (developers.openai.com/api/docs/pricing, read 2026-09-27).
const IMAGE_PRICING: Readonly<
  Record<string, { textInput: number; imageInput: number; imageOutput: number }>
> = {
  'gpt-image-2': { textInput: 5, imageInput: 8, imageOutput: 30 },
  'gpt-image-2.5-flare': { textInput: 5, imageInput: 8, imageOutput: 30 },
  'gpt-image-2.5-sunburst': { textInput: 5, imageInput: 8, imageOutput: 30 },
  'gpt-image-1': { textInput: 5, imageInput: 10, imageOutput: 40 },
};
const EMBEDDING_USD_PER_MTOK = 0.13;
/** Pre-submit estimate for the router's budget check: spec 6.5 "£0.04 per image". */
export const IMAGE_ESTIMATE_PENCE = 4;

// Documented GPT image sizes. 4:5 has no fixed size; gpt-image-2 accepts any WxH with both
// sides divisible by 16, so 1024x1280 is used.
const SIZE_FOR_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:5': '1024x1280',
};

export interface OpenAIClientLike extends OpenAITextClient {
  images: {
    generate(params: OpenAI.ImageGenerateParamsNonStreaming): Promise<OpenAI.ImagesResponse>;
  };
  embeddings: {
    create(params: OpenAI.EmbeddingCreateParams): Promise<OpenAI.CreateEmbeddingResponse>;
  };
  models: { list(): Promise<unknown> };
}

export interface OpenAIAdapterOptions {
  client: OpenAIClientLike;
  storage: AssetStorage;
  bucket: string;
  usdToGbpRate: number;
  imageModel?: string;
  /** 15.C1: OPENAI_TEXT_MODEL (default gpt-6-sol); needs a TEXT_PRICING row. */
  textModel?: string;
  /** Downloads media for transcription (the endpoint takes a file, not a URL). */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function classifySdkError(err: unknown): ErrorClassification {
  if (err instanceof OpenAI.APIConnectionTimeoutError)
    return { errorClass: 'timeout', retryable: true };
  if (err instanceof OpenAI.APIConnectionError)
    return { errorClass: 'provider_unavailable', retryable: true };
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    // 429 is both rate limiting (retry) and quota exhaustion (don't) — tell them apart by code.
    if (err.status === 429 && err.code === 'insufficient_quota') {
      return { errorClass: 'insufficient_credits', retryable: false };
    }
    if (err.status === 400 && err.code === 'moderation_blocked') {
      return { errorClass: 'content_policy', retryable: false };
    }
    return classifyHttpStatus(err.status);
  }
  return { errorClass: 'unknown', retryable: false };
}

export function imageCostUsd(
  model: string,
  usage: OpenAI.ImagesResponse['usage'],
): number | undefined {
  const price = IMAGE_PRICING[model];
  if (!price || !usage) return undefined;
  const text = usage.input_tokens_details?.text_tokens ?? usage.input_tokens;
  const image = usage.input_tokens_details?.image_tokens ?? 0;
  return (
    (text * price.textInput + image * price.imageInput + usage.output_tokens * price.imageOutput) /
    1_000_000
  );
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = [
    'text_to_image',
    'embedding',
    'text_generation',
    'transcription',
  ];
  readonly typicalLatencySec = 60; // image guide: complex prompts "may take up to 2 minutes"

  private readonly results: SyncJobStore;
  private readonly imageModel: string;
  private readonly textModel: string;
  private readonly now: () => number;

  constructor(private readonly options: OpenAIAdapterOptions) {
    this.imageModel = options.imageModel ?? DEFAULT_IMAGE_MODEL;
    this.textModel = options.textModel ?? DEFAULT_TEXT_MODEL;
    if (!TEXT_PRICING[this.textModel]) {
      throw new ConfigurationError(`No pricing configured for OpenAI text model ${this.textModel}`);
    }
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  estimateCostPence(request: ProviderRequest): number {
    const rate = this.options.usdToGbpRate;
    if (request.capability === 'text_to_image') return IMAGE_ESTIMATE_PENCE;
    if (request.capability === 'text_generation')
      return estimateTextPence(this.textModel, request, rate);
    if (request.capability === 'transcription')
      return transcriptionPence(request.durationSec, rate);
    return 1;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    let result: ProviderPollResult;
    let costPence: number;
    if (request.capability === 'text_to_image') {
      ({ result, costPence } = await this.generateImage(request));
    } else if (request.capability === 'embedding') {
      ({ result, costPence } = await this.embed(request));
    } else if (request.capability === 'text_generation') {
      ({ result, costPence } = await generateText(
        this.options.client,
        this.textModel,
        request,
        this.options.usdToGbpRate,
        (fn) => this.call(fn),
      ));
    } else if (request.capability === 'transcription') {
      ({ result, costPence } = await transcribe(
        this.options.client,
        request,
        { rate: this.options.usdToGbpRate, fetchImpl: this.options.fetchImpl ?? fetch },
        (fn) => this.call(fn),
      ));
    } else {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `OpenAI adapter does not support ${request.capability}`,
      );
    }
    return {
      providerJobId: this.results.put(result),
      estimatedCostPence: costPence,
      estimatedReadyAt: new Date(this.now()),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    return this.results.get(providerJobId);
  }

  async cancel(providerJobId: string): Promise<void> {
    this.results.delete(providerJobId);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.options.client.models.list();
      return { healthy: true };
    } catch (err) {
      return {
        healthy: false,
        reason: `${classifySdkError(err).errorClass}: ${(err as Error).message}`,
      };
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw providerError(PROVIDER_ID, classifySdkError(err), (err as Error).message);
    }
  }

  private async generateImage(request: TextToImageRequest) {
    const response = await this.call(() =>
      this.options.client.images.generate({
        model: this.imageModel,
        prompt: request.prompt,
        n: 1,
        size: SIZE_FOR_ASPECT[request.aspectRatio] as OpenAI.ImageGenerateParams['size'],
        output_format: 'png',
      }),
    );
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'OpenAI image response contained no image data',
      );
    }
    const stored = await this.options.storage.put({
      bucket: this.options.bucket,
      key: providerOutputKey({
        organisationId: request.organisationId,
        projectId: request.projectId,
        providerId: PROVIDER_ID,
        extension: 'png',
      }),
      body: Buffer.from(b64, 'base64'),
      contentType: 'image/png',
    });
    const usd = imageCostUsd(this.imageModel, response.usage);
    const costPence =
      usd === undefined ? IMAGE_ESTIMATE_PENCE : usdToPence(usd, this.options.usdToGbpRate);
    const result: ProviderPollResult = {
      state: 'succeeded',
      output: {
        url: stored.url,
        metadata: {
          model: this.imageModel,
          s3Bucket: stored.bucket,
          s3Key: stored.key,
          size: response.size ?? SIZE_FOR_ASPECT[request.aspectRatio],
          usage: response.usage ?? null,
          costPence,
        },
      },
    };
    return { result, costPence };
  }

  private async embed(request: EmbeddingRequest) {
    if (request.input.length === 0 || request.input.length > EMBEDDING_MAX_INPUTS) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Embedding input must contain 1–${EMBEDDING_MAX_INPUTS} strings`,
      );
    }
    const response = await this.call(() =>
      this.options.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: request.input,
        dimensions: request.dimensions,
      }),
    );
    const costPence = usdToPence(
      (response.usage.prompt_tokens * EMBEDDING_USD_PER_MTOK) / 1_000_000,
      this.options.usdToGbpRate,
    );
    const result: ProviderPollResult = {
      state: 'succeeded',
      output: {
        metadata: {
          model: EMBEDDING_MODEL,
          dimensions: request.dimensions,
          embeddings: [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding),
          usage: response.usage,
          costPence,
        },
      },
    };
    return { result, costPence };
  }
}
