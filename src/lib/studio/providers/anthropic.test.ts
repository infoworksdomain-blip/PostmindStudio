import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ProviderError } from '../../errors';
import {
  AnthropicAdapter,
  classifyAnthropicError,
  computeCostUsd,
  type AnthropicClientLike,
} from './anthropic';

// Fixtures follow the Messages API response shape (@anthropic-ai/sdk Message type). Replace
// with recordings from scripts/test-anthropic.ts once staging keys are available.
function recordedMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_01Studio',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
      {
        type: 'text',
        text: '{"hook":"Stop scrolling","keyMessage":"Save 2h a week"}',
        citations: null,
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  } as Anthropic.Message;
}

function client(create: AnthropicClientLike['messages']['create']): AnthropicClientLike {
  return {
    messages: { create },
    models: { retrieve: vi.fn(async () => ({ id: 'claude-sonnet-5' })) },
  };
}

const request = {
  capability: 'text_generation' as const,
  organisationId: 'org-1',
  projectId: 'proj-1',
  system: 'You are PostMind Studio ideation.',
  prompt: 'Brief: launch video for a bakery',
};

describe('computeCostUsd', () => {
  it('prices input, output and cache tokens per MTok', () => {
    const usd = computeCostUsd('claude-sonnet-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    } as Anthropic.Usage);
    // 2 + 10 + 2*1.25 + 2*0.1
    expect(usd).toBeCloseTo(14.7, 6);
  });

  it('refuses to price an unknown model', () => {
    expect(() => computeCostUsd('claude-unknown', {} as Anthropic.Usage)).toThrow(
      ConfigurationError,
    );
  });
});

describe('AnthropicAdapter', () => {
  it('rejects a model without a pricing row at construction', () => {
    expect(
      () => new AnthropicAdapter({ client: client(vi.fn()), model: 'x', usdToGbpRate: 0.75 }),
    ).toThrow(ConfigurationError);
  });

  it('submit + poll compose to one Claude call with exact cost', async () => {
    const create = vi.fn(async () => recordedMessage());
    const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
    const submitted = await adapter.submit(request);
    // (1200*2 + 300*10)/1e6 = $0.0054 → 0.405p → rounds up to 1p
    expect(submitted.estimatedCostPence).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    });

    const polled = await adapter.poll(submitted.providerJobId);
    expect(polled.state).toBe('succeeded');
    expect(polled.output?.url).toBeUndefined();
    expect(polled.output?.metadata).toMatchObject({
      model: 'claude-sonnet-5',
      text: '{"hook":"Stop scrolling","keyMessage":"Save 2h a week"}',
      usage: { inputTokens: 1200, outputTokens: 300 },
      costPence: 1,
    });
  });

  it('requests structured output and parses JSON when a schema is given', async () => {
    const create = vi.fn(async () => recordedMessage());
    const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
    const schema = { type: 'object', properties: { hook: { type: 'string' } } };
    const { providerJobId } = await adapter.submit({
      ...request,
      outputSchema: schema,
      maxTokens: 2000,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 2000,
        output_config: { format: { type: 'json_schema', schema } },
      }),
    );
    const polled = await adapter.poll(providerJobId);
    expect(polled.output?.metadata).toMatchObject({ json: { hook: 'Stop scrolling' } });
  });

  it('fails retryably when structured output is not JSON', async () => {
    const create = vi.fn(async () =>
      recordedMessage({ content: [{ type: 'text', text: 'not json', citations: null }] }),
    );
    const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
    const { providerJobId } = await adapter.submit({
      ...request,
      outputSchema: { type: 'object' },
    });
    expect(await adapter.poll(providerJobId)).toMatchObject({
      state: 'failed',
      error: { retryable: true },
    });
  });

  it.each([
    ['refusal', 'content_policy'],
    ['max_tokens', 'output_truncated'],
  ] as const)(
    'maps stop_reason %s to a non-retryable %s failure',
    async (stopReason, errorClass) => {
      const create = vi.fn(async () => recordedMessage({ stop_reason: stopReason }));
      const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
      const { providerJobId } = await adapter.submit(request);
      expect(await adapter.poll(providerJobId)).toMatchObject({
        state: 'failed',
        error: { class: errorClass, retryable: false },
      });
    },
  );

  it.each([
    [
      new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers()),
      'rate_limited',
      true,
    ],
    [
      new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers()),
      'provider_unavailable',
      true,
    ],
    [new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()), 'auth', false],
    [new Anthropic.BadRequestError(400, undefined, 'bad', new Headers()), 'invalid_request', false],
    [new Anthropic.APIConnectionTimeoutError({ message: 'timeout' }), 'timeout', true],
    [new Anthropic.APIConnectionError({ message: 'reset' }), 'provider_unavailable', true],
  ])('maps SDK error %o to %s', async (sdkError, errorClass, retryable) => {
    const create = vi.fn(async () => {
      throw sdkError;
    });
    const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
    const err = (await adapter.submit(request).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ providerId: 'anthropic', errorClass, retryable });
  });

  it('sends image content blocks before the text prompt when images are given', async () => {
    const create = vi.fn(async () => recordedMessage());
    const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
    await adapter.submit({
      ...request,
      images: [
        { mediaType: 'image/jpeg', data: 'base64-frame-1' },
        { mediaType: 'image/jpeg', data: 'base64-frame-2' },
      ],
    });
    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      system: request.system,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'base64-frame-1' },
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'base64-frame-2' },
            },
            { type: 'text', text: request.prompt },
          ],
        },
      ],
    });
  });

  it('adds an upper-bound image token cost per image to the estimate', () => {
    const adapter = new AnthropicAdapter({ client: client(vi.fn()), usdToGbpRate: 0.75 });
    const withoutImages = adapter.estimateCostPence({ ...request, maxTokens: 100 });
    const withFiveImages = adapter.estimateCostPence({
      ...request,
      maxTokens: 100,
      images: Array.from({ length: 5 }, () => ({ mediaType: 'image/jpeg' as const, data: 'x' })),
    });
    expect(withFiveImages).toBeGreaterThan(withoutImages);
  });

  it('estimates an upper-bound cost for the router budget check', () => {
    const adapter = new AnthropicAdapter({ client: client(vi.fn()), usdToGbpRate: 0.75 });
    // system+prompt = 64 chars → 16 input tokens; 16000 output tokens at $10/M = $0.16 → 13p
    expect(adapter.estimateCostPence({ ...request, maxTokens: 16000 })).toBe(13);
    expect(
      adapter.estimateCostPence({
        capability: 'tts',
        organisationId: 'o',
        text: 't',
        voiceId: 'v',
      }),
    ).toBe(0);
  });

  it('rejects unsupported capabilities', async () => {
    const adapter = new AnthropicAdapter({ client: client(vi.fn()), usdToGbpRate: 0.75 });
    await expect(
      adapter.submit({ capability: 'tts', organisationId: 'o', text: 'hi', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });

  it('cancel discards the parked result', async () => {
    const adapter = new AnthropicAdapter({
      client: client(vi.fn(async () => recordedMessage())),
      usdToGbpRate: 0.75,
    });
    const { providerJobId } = await adapter.submit(request);
    await adapter.cancel(providerJobId);
    expect(await adapter.poll(providerJobId)).toMatchObject({ error: { class: 'result_expired' } });
  });

  it('health check retrieves the configured model', async () => {
    const healthy = new AnthropicAdapter({ client: client(vi.fn()), usdToGbpRate: 0.75 });
    await expect(healthy.healthCheck()).resolves.toEqual({ healthy: true });

    const broken: AnthropicClientLike = {
      messages: { create: vi.fn() },
      models: {
        retrieve: vi.fn(async () => {
          throw new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers());
        }),
      },
    };
    const result = await new AnthropicAdapter({ client: broken, usdToGbpRate: 0.75 }).healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('auth');
  });
});

// 20.11 — account-level errors, bodies exactly as documented (read 2026-09-30):
// platform.claude.com/docs/en/api/errors and platform.claude.com/docs/en/api/rate-limits.
describe('Anthropic account errors (20.11)', () => {
  // "Setting your own spend limit": 400 invalid_request_error; the message begins "You have
  // reached your specified API usage limits" and states when access resumes (the production body).
  const orgSpendLimit = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
    },
    request_id: 'req_011Studio',
  };
  const workspaceSpendLimit = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
    },
    request_id: 'req_011Studio',
  };
  // "Reaching your spend cap": the documented 429 body.
  const tierSpendCap = {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message:
        "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.",
      details: { error_code: 'enforced_spend_limit_reached' },
    },
    request_id: 'req_018EeWyXxfu5pfWkrYcMdjWG',
  };
  const billing = {
    type: 'error',
    error: { type: 'billing_error', message: 'There is an issue with your billing.' },
  };

  it.each([
    [400, orgSpendLimit, 'account_limit', '2026-10-01T00:00:00.000Z'],
    [400, workspaceSpendLimit, 'account_limit', '2026-10-01T00:00:00.000Z'],
    [429, tierSpendCap, 'account_limit', '2026-09-01T00:00:00.000Z'],
    [402, billing, 'insufficient_credits', undefined],
  ])('classifies %i %o as %s', (status, body, errorClass, retryAt) => {
    const info = classifyAnthropicError(status, body);
    expect(info).toMatchObject({ errorClass, retryable: false });
    expect(info.retryAt).toBe(retryAt);
  });

  it('keeps an ordinary 429 a retryable rate limit and an ordinary 400 invalid', () => {
    const rate = {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Number of requests has exceeded your rate limit',
      },
    };
    expect(classifyAnthropicError(429, rate)).toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
    });
    const bad = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens' } };
    expect(classifyAnthropicError(400, bad)).toMatchObject({ errorClass: 'invalid_request' });
    expect(classifyAnthropicError(401, undefined)).toMatchObject({ errorClass: 'auth' });
    expect(classifyAnthropicError(403, undefined)).toMatchObject({ errorClass: 'auth' });
  });

  it('throws account_limit with the resume time and the readable message, not the raw JSON', async () => {
    const create = vi.fn(async () => {
      throw Anthropic.APIError.generate(400, orgSpendLimit, undefined, new Headers());
    });
    const adapter = new AnthropicAdapter({ client: client(create), usdToGbpRate: 0.75 });
    const err = (await adapter.submit(request).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ providerId: 'anthropic', errorClass: 'account_limit' });
    expect(err.retryable).toBe(false);
    expect(err.details?.retryAt).toBe('2026-10-01T00:00:00.000Z');
    expect(err.message).toBe(
      '400 You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
    );
    expect(err.message).not.toContain('{');
  });
});
