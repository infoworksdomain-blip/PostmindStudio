import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ProviderError } from '../../errors';
import { AnthropicAdapter, computeCostUsd, type AnthropicClientLike } from './anthropic';

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
