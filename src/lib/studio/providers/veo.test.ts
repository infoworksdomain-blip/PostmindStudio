import { describe, expect, it } from 'vitest';
import { ConfigurationError, NotImplementedError, ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { defaultSystemFlags, PROVIDER_IDS } from '../system-flags';
import {
  classifyOperationError,
  classifyVeoHttpError,
  DEFAULT_VEO_MODEL,
  personGenerationFor,
  VeoAdapter,
  veoDuration,
  veoOptionsFromEnv,
  VEO_RATIO,
} from './veo';

// Fixtures follow ai.google.dev/gemini-api/docs/veo (REST predictLongRunning + operation poll)
// and the official js-genai REST mapping (generateVideoResponse.generatedSamples[].video.uri,
// raiMediaFilteredCount / raiMediaFilteredReasons). No real API is called.
const NOW = Date.parse('2026-10-02T12:00:00Z');
const KEY = 'FAKE-gemini-key-0123456789';
const OP = 'models/veo-3.1-fast-generate-preview/operations/abc123xyz';
const VIDEO_URI =
  'https://generativelanguage.googleapis.com/v1beta/files/vid123:download?alt=media';

function adapter(
  replies: Parameters<typeof fakeFetch>,
  options: Partial<ConstructorParameters<typeof VeoAdapter>[0]> = {},
) {
  const fake = fakeFetch(...replies);
  return {
    veo: new VeoAdapter({
      apiKey: KEY,
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
      ...options,
    }),
    requests: fake.requests,
  };
}

const t2v = {
  capability: 'text_to_video' as const,
  organisationId: 'org-1',
  prompt: '  Steam rising from fresh bread  ',
  durationSec: 5,
  aspectRatio: '9:16' as const,
};

const running = { name: OP, metadata: {} };
const done = {
  name: OP,
  done: true,
  response: {
    '@type': 'type.googleapis.com/google.ai.generativelanguage.v1beta.PredictLongRunningResponse',
    generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] },
  },
};

describe('format mapping', () => {
  it.each([
    [1, 4],
    [4, 4],
    [4.1, 6],
    [6, 6],
    [7.5, 8],
    [8, 8],
  ])('a %ss shot renders as a %ss clip (next supported length up)', (shot, clip) => {
    expect(veoDuration(shot)).toBe(clip);
  });

  it('maps 16:9 and 9:16 directly, 4:5 to portrait and 1:1 to landscape', () => {
    expect(VEO_RATIO).toEqual({ '9:16': '9:16', '16:9': '16:9', '4:5': '9:16', '1:1': '16:9' });
  });

  it('image-to-video always uses allow_adult; text-to-video sends only a configured value', () => {
    expect(personGenerationFor('image_to_video', 'allow_all')).toBe('allow_adult');
    expect(personGenerationFor('image_to_video', undefined)).toBe('allow_adult');
    expect(personGenerationFor('text_to_video', 'allow_all')).toBe('allow_all');
    // The live API refuses allow_adult for text-to-video, so nothing is sent by default.
    expect(personGenerationFor('text_to_video', undefined)).toBeUndefined();
  });
});

describe('veoOptionsFromEnv', () => {
  it('defaults (empty) leave the adapter defaults', () => {
    expect(veoOptionsFromEnv({})).toEqual({});
    expect(veoOptionsFromEnv({ VEO_MODEL: ' ', VEO_PERSON_GENERATION: '' })).toEqual({});
  });

  it('reads a documented model and person setting', () => {
    expect(
      veoOptionsFromEnv({
        VEO_MODEL: 'veo-3.1-generate-preview',
        VEO_PERSON_GENERATION: 'allow_all',
      }),
    ).toEqual({ model: 'veo-3.1-generate-preview', personGeneration: 'allow_all' });
  });

  it('rejects an unknown model (no price row) or person value', () => {
    expect(() => veoOptionsFromEnv({ VEO_MODEL: 'veo-3.0-generate-001' })).toThrow(
      ConfigurationError,
    );
    expect(() => veoOptionsFromEnv({ VEO_PERSON_GENERATION: 'dont_allow' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('VeoAdapter.submit', () => {
  it('posts predictLongRunning with the key header, 720p and the mapped parameters', async () => {
    const { veo, requests } = adapter([json(running)]);
    const submitted = await veo.submit(t2v);
    expect(requests[0]).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_VEO_MODEL}:predictLongRunning`,
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
      body: {
        instances: [{ prompt: 'Steam rising from fresh bread' }],
        parameters: {
          aspectRatio: '9:16',
          durationSeconds: 6,
          resolution: '720p',
          sampleCount: 1,
        },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('generateAudio');
    // Text-to-video sends no personGeneration by default (allow_adult is refused there).
    expect(JSON.stringify(requests[0]?.body)).not.toContain('personGeneration');
    // Veo 3.1 Fast 720p $0.10/s × 6 s = $0.60 × 0.75 = 45p
    expect(submitted).toEqual({
      providerJobId: OP,
      estimatedCostPence: 45,
      estimatedReadyAt: new Date(NOW + 120_000),
    });
  });

  it('uses the configured model and person setting', async () => {
    const { veo, requests } = adapter([json(running)], {
      model: 'veo-3.1-generate-preview',
      personGeneration: 'allow_all',
    });
    await veo.submit({ ...t2v, durationSec: 8, aspectRatio: '1:1' });
    expect(requests[0]?.url).toContain('/models/veo-3.1-generate-preview:predictLongRunning');
    expect(requests[0]?.body).toMatchObject({
      parameters: { aspectRatio: '16:9', durationSeconds: 8, personGeneration: 'allow_all' },
    });
  });

  it('sends a source frame inline (base64) with allow_adult for image-to-video', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { veo, requests } = adapter(
      [new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }), json(running)],
      { personGeneration: 'allow_all' },
    );
    await veo.submit({
      ...t2v,
      capability: 'image_to_video',
      imageUrl: 'https://cdn.example/frame.png',
      aspectRatio: '4:5',
    });
    expect(requests[0]).toMatchObject({ url: 'https://cdn.example/frame.png', method: 'GET' });
    expect(requests[0]?.headers['x-goog-api-key']).toBeUndefined();
    expect(requests[1]?.body).toMatchObject({
      instances: [
        {
          prompt: 'Steam rising from fresh bread',
          image: { bytesBase64Encoded: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
        },
      ],
      parameters: { aspectRatio: '9:16', personGeneration: 'allow_adult' },
    });
  });

  it('refuses non-https or non-PNG/JPEG source frames before calling Veo', async () => {
    const { veo, requests } = adapter([
      new Response('gif', { status: 200, headers: { 'Content-Type': 'image/gif' } }),
    ]);
    const i2v = { ...t2v, capability: 'image_to_video' as const };
    await expect(
      veo.submit({ ...i2v, imageUrl: 'http://cdn.example/a.png' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    await expect(
      veo.submit({ ...i2v, imageUrl: 'https://cdn.example/a.gif' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(requests).toHaveLength(1);
  });

  it('rejects shots over 8 s, empty prompts and other capabilities without a request', async () => {
    const { veo, requests } = adapter([]);
    await expect(veo.submit({ ...t2v, durationSec: 9 })).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
    await expect(veo.submit({ ...t2v, prompt: '   ' })).rejects.toBeInstanceOf(ProviderError);
    await expect(
      veo.submit({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('fails retryably when Veo returns no operation name', async () => {
    const { veo } = adapter([json({})]);
    await expect(veo.submit(t2v)).rejects.toMatchObject({ errorClass: 'unknown', retryable: true });
  });
});

describe('VeoAdapter routing hints and cost', () => {
  it('supports 1–8 s clip shots only', () => {
    const { veo } = adapter([]);
    expect(veo.supportsRequest({ ...t2v, durationSec: 8 })).toBe(true);
    expect(veo.supportsRequest({ ...t2v, durationSec: 8.5 })).toBe(false);
    expect(
      veo.supportsRequest({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
    ).toBe(false);
  });

  it.each([
    ['veo-3.1-fast-generate-preview', 4, 30], // $0.40 × 0.75 = 30p
    ['veo-3.1-fast-generate-preview', 8, 60], // $0.80 → 60p
    ['veo-3.1-generate-preview', 8, 240], // $3.20 → 240p
    ['veo-3.1-lite-generate-preview', 6, 23], // $0.30 → 22.5p → 23p
  ] as const)('%s, %ss clip → %sp', (model, seconds, pence) => {
    const { veo } = adapter([], { model });
    expect(veo.estimateCostPence({ ...t2v, durationSec: seconds })).toBe(pence);
  });

  it('estimates 0 for capabilities it does not do', () => {
    const { veo } = adapter([]);
    expect(
      veo.estimateCostPence({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
    ).toBe(0);
  });
});

describe('VeoAdapter.poll', () => {
  it('submit → running → done → video URI', async () => {
    const { veo, requests } = adapter([json(running), json(running), json(done)]);
    const { providerJobId } = await veo.submit(t2v);
    expect(await veo.poll(providerJobId)).toEqual({ state: 'running' });
    const result = await veo.poll(providerJobId);
    expect(requests[1]).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/${OP}`,
      method: 'GET',
      headers: { 'x-goog-api-key': KEY },
    });
    expect(result).toEqual({
      state: 'succeeded',
      output: {
        url: VIDEO_URI,
        metadata: expect.objectContaining({
          operationName: OP,
          model: DEFAULT_VEO_MODEL,
          resolution: '720p',
          urlExpiresWithinHours: 48,
        }),
      },
    });
  });

  it('a safety-filtered result is a non-retryable content_policy failure', async () => {
    const { veo } = adapter([
      json({
        name: OP,
        done: true,
        response: {
          generateVideoResponse: {
            raiMediaFilteredCount: 1,
            raiMediaFilteredReasons: ['The prompt could not be submitted.'],
          },
        },
      }),
    ]);
    expect(await veo.poll(OP)).toEqual({
      state: 'failed',
      error: {
        class: 'content_policy',
        message: 'Veo safety filter blocked the video: The prompt could not be submitted.',
        retryable: false,
      },
    });
  });

  it('done without a video or a filter is a retryable unknown failure', async () => {
    const { veo } = adapter([json({ name: OP, done: true, response: {} })]);
    expect(await veo.poll(OP)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
  });

  it.each([
    [8, 'Quota exceeded for requests per minute', 'rate_limited', true],
    [8, 'Quota exceeded: generate requests per day', 'account_limit', false],
    [9, 'Billing is not enabled', 'insufficient_credits', false],
    [7, 'Permission denied', 'auth', false],
    [3, 'Your prompt was blocked by our safety filters', 'content_policy', false],
    [3, 'durationSeconds must be 8 for 1080p', 'invalid_request', false],
    [13, 'Internal error', 'provider_unavailable', true],
  ] as const)('operation error code %s (%s) → %s', async (code, message, cls, retryable) => {
    const { veo } = adapter([json({ name: OP, done: true, error: { code, message } })]);
    expect(await veo.poll(OP)).toEqual({
      state: 'failed',
      error: { class: cls, message: `${code}: ${message}`, retryable },
    });
  });

  it('a missing operation (404) means the result expired', async () => {
    const { veo } = adapter([
      json({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, 404),
    ]);
    expect(await veo.poll(OP)).toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('refuses a job id that is not a Veo operation name (no request)', async () => {
    const { veo, requests } = adapter([]);
    expect(await veo.poll('../../files/x')).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request' },
    });
    expect(requests).toHaveLength(0);
  });
});

describe('HTTP error classification (20.11 classes)', () => {
  const body = (status: string, message: string, details: unknown[] = []) => ({
    error: { code: 0, message, status, details },
  });

  it.each([
    [400, body('INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'), 'auth'],
    [
      400,
      body('INVALID_ARGUMENT', 'bad key', [
        { reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
      ]),
      'auth',
    ],
    [
      400,
      body('FAILED_PRECONDITION', 'Billing is not enabled for this project'),
      'insufficient_credits',
    ],
    [400, body('INVALID_ARGUMENT', 'Prompt violates our usage guidelines'), 'content_policy'],
    [400, body('INVALID_ARGUMENT', 'aspectRatio must be 16:9 or 9:16'), 'invalid_request'],
    [401, body('UNAUTHENTICATED', 'no key'), 'auth'],
    [
      402,
      body('PAYMENT_REQUIRED', 'Your Prepay credit balance is depleted'),
      'insufficient_credits',
    ],
    [403, body('PERMISSION_DENIED', 'Your API key was reported as leaked'), 'auth'],
    [429, body('RESOURCE_EXHAUSTED', 'Rate limit exceeded, retry later'), 'rate_limited'],
    [429, body('RESOURCE_EXHAUSTED', 'Spend-based rate limit reached'), 'account_limit'],
    [
      429,
      body('RESOURCE_EXHAUSTED', 'Quota exceeded', [
        { violations: [{ quotaId: 'PredictLongRunningRequestsPerDayPerProject' }] },
      ]),
      'account_limit',
    ],
    [500, body('INTERNAL', 'oops'), 'provider_unavailable'],
    [503, body('UNAVAILABLE', 'overloaded'), 'provider_unavailable'],
  ] as const)('%s %j → %s', (status, errorBody, cls) => {
    expect(classifyVeoHttpError(status, errorBody).errorClass).toBe(cls);
  });

  it('a submit failure becomes a ProviderError with the status and Google message', async () => {
    const { veo } = adapter([
      json(body('RESOURCE_EXHAUSTED', 'Quota exceeded: requests per day'), 429),
    ]);
    const err = await veo.submit(t2v).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      providerId: 'veo',
      errorClass: 'account_limit',
      retryable: false,
      message: 'RESOURCE_EXHAUSTED: Quota exceeded: requests per day',
      details: expect.objectContaining({ status: 429 }),
    });
  });

  it('operation errors accept a status name when the code is not numeric', () => {
    expect(classifyOperationError({ code: 'UNAVAILABLE', message: 'x' })).toEqual({
      class: 'provider_unavailable',
      retryable: true,
    });
    expect(classifyOperationError({ status: 'PERMISSION_DENIED', message: 'x' })).toEqual({
      class: 'auth',
      retryable: false,
    });
  });
});

describe('VeoAdapter.fetchOutput (authenticated download)', () => {
  it('sends the key to the Gemini API host and drops it on a redirect elsewhere', async () => {
    const { veo, requests } = adapter([
      new Response(null, {
        status: 302,
        headers: { Location: 'https://storage.example-cdn.com/v/abc.mp4?sig=1' },
      }),
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      }),
    ]);
    const res = await veo.fetchOutput(VIDEO_URI);
    expect(res.status).toBe(200);
    expect(requests[0]).toMatchObject({ url: VIDEO_URI, headers: { 'x-goog-api-key': KEY } });
    expect(requests[1]?.url).toBe('https://storage.example-cdn.com/v/abc.mp4?sig=1');
    expect(requests[1]?.headers['x-goog-api-key']).toBeUndefined();
  });

  it('keeps the key on a redirect within the Gemini API host', async () => {
    const { veo, requests } = adapter([
      new Response(null, { status: 307, headers: { Location: '/v1beta/files/vid123:raw' } }),
      new Response('ok', { status: 200 }),
    ]);
    await veo.fetchOutput(VIDEO_URI);
    expect(requests[1]).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/files/vid123:raw',
      headers: { 'x-goog-api-key': KEY },
    });
  });

  it('never sends the key to another host or over http', async () => {
    const { veo, requests } = adapter([]);
    await expect(veo.fetchOutput('https://evil.example/files/x')).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(
      veo.fetchOutput('http://generativelanguage.googleapis.com/v1beta/files/x'),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('gives up after too many redirects', async () => {
    const hop = () =>
      new Response(null, { status: 302, headers: { Location: '/v1beta/files/loop' } });
    const { veo } = adapter([hop, hop, hop, hop, hop, hop, hop]);
    await expect(veo.fetchOutput(VIDEO_URI)).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
    });
  });
});

describe('VeoAdapter.cancel / healthCheck', () => {
  it('cancel is honest: no documented cancel for Veo operations', async () => {
    const { veo } = adapter([]);
    await expect(veo.cancel(OP)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('health = models.get on the configured model', async () => {
    const { veo, requests } = adapter([json({ name: `models/${DEFAULT_VEO_MODEL}` })]);
    expect(await veo.healthCheck()).toEqual({ healthy: true });
    expect(requests[0]).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_VEO_MODEL}`,
      method: 'GET',
      headers: { 'x-goog-api-key': KEY },
    });
  });

  it('reports the error class when the key is refused', async () => {
    const { veo } = adapter([
      json({ error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }, 403),
    ]);
    expect(await veo.healthCheck()).toEqual({
      healthy: false,
      reason: 'auth: PERMISSION_DENIED: denied',
    });
  });
});

describe('kill switch (spec 6.7 level 4)', () => {
  it('Veo has its own provider kill-switch flag, seeded off', () => {
    expect(PROVIDER_IDS).toContain('veo');
    expect(defaultSystemFlags()).toContainEqual({
      key: 'studio.disabledProvider.veo',
      value: 'false',
    });
  });
});

describe('out-of-credit wording (20.19 shared rule)', () => {
  const body = (status: string, message: string) => ({ error: { code: 0, message, status } });

  it.each([
    [400, body('INVALID_ARGUMENT', 'You do not have enough credits to run this task.')],
    [400, body('', 'Insufficient balance on this project')],
    [418, body('', 'You are out of credits')],
  ] as const)('HTTP %s with out-of-credit text → insufficient_credits', (status, errorBody) => {
    expect(classifyVeoHttpError(status, errorBody)).toEqual({
      errorClass: 'insufficient_credits',
      retryable: false,
    });
  });

  it('does not upgrade generic input errors, safety blocks or retryable failures', () => {
    expect(classifyVeoHttpError(400, body('INVALID_ARGUMENT', 'bad aspectRatio')).errorClass).toBe(
      'invalid_request',
    );
    expect(classifyVeoHttpError(503, body('UNAVAILABLE', 'not enough credits')).errorClass).toBe(
      'provider_unavailable',
    );
  });

  it('a finished operation that failed for lack of credit is an account problem', () => {
    expect(
      classifyOperationError({ code: 3, message: 'Insufficient credits to generate the video' }),
    ).toEqual({ class: 'insufficient_credits', retryable: false });
    expect(classifyOperationError({ code: 99, message: 'not enough credits' })).toEqual({
      class: 'insufficient_credits',
      retryable: false,
    });
  });

  it('a submit with out-of-credit text fails over as an account error', async () => {
    const { veo } = adapter([
      json(body('INVALID_ARGUMENT', 'You do not have enough credits to run this task.'), 400),
    ]);
    await expect(veo.submit(t2v)).rejects.toMatchObject({
      errorClass: 'insufficient_credits',
      retryable: false,
    });
  });
});
