import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { OpenAIAdapter, type OpenAIClientLike } from './openai';
import {
  isStrictCompatible,
  MAX_TRANSCRIPTION_BYTES,
  textCostUsd,
  transcriptionFileName,
} from './openai-text';

// 15.C1 — recorded fixtures follow the documented Responses API and verbose_json transcription
// shapes (developers.openai.com/api/docs/guides/structured-outputs and …/speech-to-text).

function response(overrides: Record<string, unknown> = {}): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-6-sol',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"hook":"Hi"}', annotations: [] }],
      },
    ],
    output_text: '{"hook":"Hi"}',
    usage: {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1_500,
    },
    ...overrides,
  } as unknown as OpenAI.Responses.Response;
}

const verbose = {
  text: 'I consent',
  language: 'english',
  duration: 30,
  words: [
    { word: 'I', start: 0, end: 0.2 },
    { word: 'consent', start: 0.2, end: 0.8 },
  ],
} as OpenAI.Audio.TranscriptionVerbose;

function setup(
  opts: {
    create?: () => Promise<unknown>;
    transcribe?: () => Promise<unknown>;
    replies?: Parameters<typeof fakeFetch>;
  } = {},
) {
  const create = vi.fn(opts.create ?? (async () => response()));
  const transcriptions = vi.fn(opts.transcribe ?? (async () => verbose));
  const fake = fakeFetch(...(opts.replies ?? []));
  const client = {
    responses: { create },
    audio: { transcriptions: { create: transcriptions } },
    images: { generate: vi.fn() },
    embeddings: { create: vi.fn() },
    models: { list: vi.fn() },
  } as unknown as OpenAIClientLike;
  const adapter = new OpenAIAdapter({
    client,
    storage: memoryStorage().storage,
    bucket: 'assets',
    usdToGbpRate: 0.75,
    fetchImpl: fake.fetch,
  });
  return { adapter, create, transcriptions, requests: fake.requests };
}

const textRequest = {
  capability: 'text_generation' as const,
  organisationId: 'org-1',
  system: 'You write scripts.',
  prompt: 'Write one.',
  maxTokens: 2_000,
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['hook'],
    properties: { hook: { type: 'string' } },
  },
};

describe('OpenAI text generation (15.C1)', () => {
  it('declares the fallback capabilities', () => {
    expect(setup().adapter.capabilities).toEqual(
      expect.arrayContaining(['text_generation', 'transcription']),
    );
  });

  it('calls the Responses API with a strict JSON schema and parses the JSON', async () => {
    const { adapter, create } = setup();
    const submitted = await adapter.submit({
      ...textRequest,
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-6-sol',
        instructions: 'You write scripts.',
        max_output_tokens: 2_000,
        store: false,
        text: {
          format: expect.objectContaining({
            type: 'json_schema',
            strict: true,
            schema: textRequest.outputSchema,
          }),
        },
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AAAA' },
              { type: 'input_text', text: 'Write one.' },
            ],
          },
        ],
      }),
    );
    // (800*2 + 200*0.2 + 500*10)/1e6 USD = 0.00664 → 0.498p → 1p
    expect(submitted.estimatedCostPence).toBe(1);
    expect(await adapter.poll(submitted.providerJobId)).toMatchObject({
      state: 'succeeded',
      output: { metadata: { json: { hook: 'Hi' }, model: 'gpt-6-sol', costPence: 1 } },
    });
  });

  it('sends schemas with optional properties as non-strict', async () => {
    const { adapter, create } = setup();
    await adapter.submit({
      ...textRequest,
      outputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: [] },
    });
    const params = (create.mock.calls[0] as unknown[] | undefined)?.[0] as {
      text: { format: { strict: boolean } };
    };
    expect(params.text.format.strict).toBe(false);
  });

  it.each([
    [
      'a refusal',
      {
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        ],
      },
      'content_policy',
    ],
    [
      'a content filter stop',
      { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      'content_policy',
    ],
    [
      'truncation',
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      'output_truncated',
    ],
    ['invalid JSON', { output_text: 'not json' }, 'unknown'],
  ])('reports %s as a failed job', async (_label, overrides, errorClass) => {
    const { adapter } = setup({ create: async () => response(overrides) });
    const polled = await adapter.poll((await adapter.submit(textRequest)).providerJobId);
    expect(polled).toMatchObject({ state: 'failed', error: { class: errorClass } });
  });

  it('classifies SDK errors (rate limit retryable)', async () => {
    const err = new OpenAI.APIError(429, { message: 'slow down' }, 'slow down', new Headers());
    const { adapter } = setup({
      create: async () => {
        throw err;
      },
    });
    await expect(adapter.submit(textRequest)).rejects.toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
    });
  });

  it('estimates an upper bound and rejects unknown models', () => {
    const { adapter } = setup();
    expect(adapter.estimateCostPence(textRequest)).toBeGreaterThan(0);
    expect(
      () =>
        new OpenAIAdapter({
          client: {} as OpenAIClientLike,
          storage: memoryStorage().storage,
          bucket: 'b',
          usdToGbpRate: 0.75,
          textModel: 'gpt-2',
        }),
    ).toThrow(/No pricing configured/);
  });

  it('prices cached input at the cached rate', () => {
    expect(textCostUsd('gpt-6-sol', response().usage)).toBeCloseTo(0.00664, 6);
    expect(textCostUsd('mystery', response().usage)).toBeUndefined();
  });

  it('isStrictCompatible needs every property required and closed objects', () => {
    expect(isStrictCompatible(textRequest.outputSchema)).toBe(true);
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: ['a'],
        properties: { a: { type: 'array', items: { type: 'object', properties: { b: {} } } } },
      }),
    ).toBe(false);
  });
});

describe('OpenAI transcription (15.C1)', () => {
  const transcription = {
    capability: 'transcription' as const,
    organisationId: 'org-1',
    mediaUrl: 'https://signed.example/assets/voice.mp3?sig=1',
    durationSec: 30,
  };

  it('downloads the media, sends whisper-1 verbose_json with word timestamps', async () => {
    const { adapter, transcriptions, requests } = setup({
      replies: [
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
      ],
    });
    const submitted = await adapter.submit(transcription);
    expect(requests[0]!.url).toBe(transcription.mediaUrl);
    const params = (transcriptions.mock.calls[0] as unknown[] | undefined)?.[0] as {
      model: string;
      response_format: string;
      timestamp_granularities: string[];
      file: File;
    };
    expect(params).toMatchObject({
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });
    expect(params.file.name).toBe('media.mp3');
    // 0.5 min × $0.006 × 0.75 = 0.00225p → rounds up to 1p
    expect(submitted.estimatedCostPence).toBe(1);
    expect(await adapter.poll(submitted.providerJobId)).toMatchObject({
      state: 'succeeded',
      output: {
        metadata: {
          text: 'I consent',
          words: [
            { text: 'I', startSec: 0, endSec: 0.2 },
            { text: 'consent', startSec: 0.2, endSec: 0.8 },
          ],
          audioDurationSec: 30,
        },
      },
    });
  });

  it('passes the ISO 639-1 language when the request has one (15.C5)', async () => {
    const reply = () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    const { adapter, transcriptions } = setup({ replies: [reply(), reply()] });
    await adapter.submit({ ...transcription, languageCode: 'zh-Hans' });
    await adapter.submit(transcription);
    const calls = transcriptions.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]?.[0]).toMatchObject({ language: 'zh' });
    expect(calls[1]?.[0]).not.toHaveProperty('language');
  });

  it('refuses media over 25 MB without buffering it', async () => {
    const { adapter, transcriptions } = setup({
      replies: [
        new Response(new Uint8Array(1), {
          headers: { 'content-length': String(MAX_TRANSCRIPTION_BYTES + 1) },
        }),
      ],
    });
    await expect(adapter.submit(transcription)).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(transcriptions).not.toHaveBeenCalled();
  });

  it('maps a failed download and an empty file', async () => {
    const { adapter } = setup({
      replies: [new Response('gone', { status: 403 }), new Response(new Uint8Array(0))],
    });
    await expect(adapter.submit(transcription)).rejects.toMatchObject({ errorClass: 'auth' });
    await expect(adapter.submit(transcription)).rejects.toThrow(/empty/);
  });

  it('names the upload from the content type or the URL', () => {
    expect(transcriptionFileName('video/mp4; codecs=avc1', 'https://x/y')).toBe('media.mp4');
    expect(transcriptionFileName(null, 'https://x/a/b.wav?sig=1')).toBe('media.wav');
    expect(transcriptionFileName('application/octet-stream', 'not a url')).toBe('media.mp3');
  });
});
