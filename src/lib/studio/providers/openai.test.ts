import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ProviderError } from '../../errors';
import { IMAGE_ESTIMATE_PENCE, imageCostUsd, OpenAIAdapter, type OpenAIClientLike } from './openai';

// Fixtures follow the documented Images / Embeddings response shapes
// (developers.openai.com/api/reference). GPT image models return b64_json only.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function imageResponse(overrides: Partial<OpenAI.ImagesResponse> = {}): OpenAI.ImagesResponse {
  return {
    created: 1_790_000_000,
    data: [{ b64_json: PNG_BYTES.toString('base64') }],
    size: '1024x1536',
    usage: {
      input_tokens: 50,
      input_tokens_details: { text_tokens: 50, image_tokens: 0 },
      output_tokens: 4160,
      total_tokens: 4210,
    },
    ...overrides,
  } as OpenAI.ImagesResponse;
}

function setup(partial: Partial<{ generate: unknown; create: unknown; list: unknown }> = {}) {
  const generate = vi.fn((partial.generate as never) ?? (async () => imageResponse()));
  const create = vi.fn(
    (partial.create as never) ??
      (async () => ({
        object: 'list',
        model: 'text-embedding-3-large',
        data: [
          { object: 'embedding', index: 1, embedding: [0.2] },
          { object: 'embedding', index: 0, embedding: [0.1] },
        ],
        usage: { prompt_tokens: 20, total_tokens: 20 },
      })),
  );
  const list = vi.fn((partial.list as never) ?? (async () => ({ data: [] })));
  const client = {
    images: { generate },
    embeddings: { create },
    models: { list },
  } as unknown as OpenAIClientLike;
  const { storage, objects } = memoryStorage();
  const adapter = new OpenAIAdapter({
    client,
    storage,
    bucket: 'studio-assets-dev',
    usdToGbpRate: 0.75,
  });
  return { adapter, generate, create, list, objects };
}

describe('imageCostUsd', () => {
  it('prices text input and image output tokens for gpt-image-2', () => {
    // (50*5 + 4160*30)/1e6
    expect(imageCostUsd('gpt-image-2', imageResponse().usage)).toBeCloseTo(0.12505, 6);
  });

  it('returns undefined when usage or pricing is missing', () => {
    expect(imageCostUsd('gpt-image-2', undefined)).toBeUndefined();
    expect(imageCostUsd('mystery', imageResponse().usage)).toBeUndefined();
  });
});

describe('OpenAIAdapter — images', () => {
  const imageRequest = {
    capability: 'text_to_image' as const,
    organisationId: 'org-1',
    projectId: 'proj-1',
    prompt: 'Croissants on a marble counter',
    aspectRatio: '9:16' as const,
  };

  it('generates with gpt-image-2, stores the PNG in S3 and returns a signed URL', async () => {
    const { adapter, generate, objects } = setup();
    const submitted = await adapter.submit(imageRequest);
    expect(generate).toHaveBeenCalledWith({
      model: 'gpt-image-2',
      prompt: imageRequest.prompt,
      n: 1,
      size: '1024x1536',
      output_format: 'png',
    });
    // $0.12505 * 0.75 = 9.38p → 10p
    expect(submitted.estimatedCostPence).toBe(10);

    const polled = await adapter.poll(submitted.providerJobId);
    const metadata = polled.output?.metadata as { s3Key: string; s3Bucket: string };
    expect(polled.state).toBe('succeeded');
    expect(metadata.s3Key).toMatch(/^orgs\/org-1\/projects\/proj-1\/providers\/openai\/.+\.png$/);
    expect(polled.output?.url).toBe(`https://signed.example/studio-assets-dev/${metadata.s3Key}`);
    expect(objects.get(`studio-assets-dev/${metadata.s3Key}`)).toMatchObject({
      contentType: 'image/png',
    });
  });

  it.each([
    ['1:1', '1024x1024'],
    ['16:9', '1536x1024'],
    ['4:5', '1024x1280'],
  ] as const)('maps aspect ratio %s to size %s', async (aspectRatio, size) => {
    const { adapter, generate } = setup();
    await adapter.submit({ ...imageRequest, aspectRatio });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ size }));
  });

  it('falls back to the spec estimate when usage is absent', async () => {
    const { adapter } = setup({ generate: async () => imageResponse({ usage: undefined }) });
    expect((await adapter.submit(imageRequest)).estimatedCostPence).toBe(IMAGE_ESTIMATE_PENCE);
  });

  it('fails retryably when no image data comes back', async () => {
    const { adapter } = setup({ generate: async () => imageResponse({ data: [] }) });
    await expect(adapter.submit(imageRequest)).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it.each([
    [
      new OpenAI.RateLimitError(429, { code: 'rate_limit_exceeded' }, 'slow', new Headers()),
      'rate_limited',
      true,
    ],
    [
      new OpenAI.RateLimitError(429, { code: 'insufficient_quota' }, 'quota', new Headers()),
      'insufficient_credits',
      false,
    ],
    // 20.11 — developers.openai.com/api/docs/guides/error-codes (read 2026-09-30).
    [
      new OpenAI.RateLimitError(
        429,
        {
          code: 'credit_balance_exhausted',
          type: 'insufficient_quota',
          message: 'Your organization has no prepaid credits remaining.',
        },
        undefined,
        new Headers(),
      ),
      'insufficient_credits',
      false,
    ],
    [
      new OpenAI.RateLimitError(
        429,
        { type: 'insufficient_quota', message: 'You have no credits remaining.' },
        undefined,
        new Headers(),
      ),
      'insufficient_credits',
      false,
    ],
    [
      new OpenAI.RateLimitError(
        429,
        { code: 'organization_spend_limit_exceeded' },
        'spend',
        new Headers(),
      ),
      'account_limit',
      false,
    ],
    [
      new OpenAI.RateLimitError(429, { code: 'project_spend_limit_exceeded' }, 'p', new Headers()),
      'account_limit',
      false,
    ],
    [
      new OpenAI.RateLimitError(
        429,
        { code: 'organization_usage_limit_exceeded' },
        'u',
        new Headers(),
      ),
      'account_limit',
      false,
    ],
    [
      new OpenAI.AuthenticationError(401, { code: 'invalid_api_key' }, 'key', new Headers()),
      'auth',
      false,
    ],
    [
      new OpenAI.BadRequestError(400, { code: 'moderation_blocked' }, 'blocked', new Headers()),
      'content_policy',
      false,
    ],
    [
      new OpenAI.InternalServerError(503, undefined, 'overloaded', new Headers()),
      'provider_unavailable',
      true,
    ],
    [new OpenAI.APIConnectionTimeoutError({ message: 't' }), 'timeout', true],
  ])('maps %o to %s', async (sdkError, errorClass, retryable) => {
    const { adapter } = setup({
      generate: async () => {
        throw sdkError;
      },
    });
    const err = (await adapter.submit(imageRequest).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ providerId: 'openai', errorClass, retryable });
  });
});

describe('OpenAIAdapter — embeddings', () => {
  const embeddingRequest = {
    capability: 'embedding' as const,
    organisationId: 'org-1',
    input: ['a', 'b'],
    dimensions: 1536,
  };

  it('requests text-embedding-3-large at 1536 dims and returns vectors in input order', async () => {
    const { adapter, create } = setup();
    const { providerJobId } = await adapter.submit(embeddingRequest);
    expect(create).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: ['a', 'b'],
      dimensions: 1536,
    });
    const polled = await adapter.poll(providerJobId);
    expect(polled.output?.metadata).toMatchObject({ embeddings: [[0.1], [0.2]], dimensions: 1536 });
  });

  it('rejects empty or oversized batches', async () => {
    const { adapter } = setup();
    await expect(adapter.submit({ ...embeddingRequest, input: [] })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(
      adapter.submit({ ...embeddingRequest, input: Array.from({ length: 2049 }, () => 'x') }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});

describe('OpenAIAdapter — misc', () => {
  it('rejects unsupported capabilities', async () => {
    const { adapter } = setup();
    await expect(
      adapter.submit({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('estimates cost for the router budget check', () => {
    const { adapter } = setup();
    expect(
      adapter.estimateCostPence({
        capability: 'text_to_image',
        organisationId: 'o',
        prompt: 'p',
        aspectRatio: '1:1',
      }),
    ).toBe(IMAGE_ESTIMATE_PENCE);
  });

  it('health check lists models', async () => {
    const ok = setup();
    await expect(ok.adapter.healthCheck()).resolves.toEqual({ healthy: true });
    const bad = setup({
      list: async () => {
        throw new OpenAI.AuthenticationError(401, undefined, 'bad key', new Headers());
      },
    });
    expect((await bad.adapter.healthCheck()).reason).toContain('auth');
  });

  it('cancel drops the parked result', async () => {
    const { adapter } = setup();
    const { providerJobId } = await adapter.submit({
      capability: 'embedding',
      organisationId: 'o',
      input: ['x'],
      dimensions: 1536,
    });
    await adapter.cancel(providerJobId);
    expect((await adapter.poll(providerJobId)).error?.class).toBe('result_expired');
  });
});
