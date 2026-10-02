import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, NotImplementedError, ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { defaultSystemFlags, PROVIDER_IDS } from '../system-flags';
import { BYOC_PROVIDER_IDS, byocProvider } from './byoc-providers';
import {
  classifyArkCode,
  classifySeedanceHttpError,
  classifyTaskError,
  DEFAULT_BASE_URL,
  DEFAULT_SEEDANCE_LONG_MODEL,
  DEFAULT_SEEDANCE_MODEL,
  isArkBaseUrl,
  SeedanceAdapter,
  seedanceDuration,
  seedanceOptionsFromEnv,
  seedanceTokens,
  SEEDANCE_RATIO,
} from './seedance';

// Fixtures follow docs.byteplus.com/en/docs/modelark (create / retrieve / list / cancel-or-delete
// video generation task, error codes; read 2026-10-02). No real API is called.
const NOW = Date.parse('2026-10-02T12:00:00Z');
const KEY = 'FAKE.byteplus.key.0123456789abcdefghijklmnopqrstuvwxyz';
const TASK = 'cgt-20261002120000-abcde';
const TASKS = `${DEFAULT_BASE_URL}/contents/generations/tasks`;
const VIDEO_URL =
  'https://ark-content-generation-ap-southeast-1.tos-ap-southeast-1.volces.com/out.mp4?X-Tos-Signature=x';

function adapter(
  replies: Parameters<typeof fakeFetch>,
  options: Partial<ConstructorParameters<typeof SeedanceAdapter>[0]> = {},
) {
  const fake = fakeFetch(...replies);
  return {
    sd: new SeedanceAdapter({
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
const i2v = {
  ...t2v,
  capability: 'image_to_video' as const,
  imageUrl: 'https://cdn.example/frame.png',
};

const task = (status: string, extra: Record<string, unknown> = {}) => ({
  id: TASK,
  model: DEFAULT_SEEDANCE_MODEL,
  status,
  created_at: 1790942400,
  updated_at: 1790942460,
  ...extra,
});
const arkError = (code: string, message = 'x', status = 400) =>
  json({ error: { code, message, param: '', type: 'BadRequest' } }, status);

describe('format and model mapping', () => {
  it('renders whole seconds, at least the model minimum (4 s)', () => {
    expect(seedanceDuration(2, DEFAULT_SEEDANCE_MODEL)).toBe(4);
    expect(seedanceDuration(4, DEFAULT_SEEDANCE_MODEL)).toBe(4);
    expect(seedanceDuration(5.2, DEFAULT_SEEDANCE_MODEL)).toBe(6);
    expect(seedanceDuration(10, DEFAULT_SEEDANCE_MODEL)).toBe(10);
  });

  it('maps 9:16, 16:9 and 1:1 directly and 4:5 to 3:4', () => {
    expect(SEEDANCE_RATIO).toEqual({ '9:16': '9:16', '16:9': '16:9', '1:1': '1:1', '4:5': '3:4' });
  });

  it('uses the default model up to 15 s and the long model (2.5) up to 30 s', () => {
    const { sd } = adapter([]);
    expect(sd.modelFor(2)).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.modelFor(15)).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.modelFor(15.5)).toBe('dreamina-seedance-2-5-260628');
    expect(sd.modelFor(30)).toBe('dreamina-seedance-2-5-260628');
    expect(sd.modelFor(31)).toBeUndefined();
    expect(sd.modelFor(0)).toBeUndefined();
    expect(sd.modelFor(Number.NaN)).toBeUndefined();
  });

  it('PLUS / ENTERPRISE use the long model (2.5) for every shot; STANDARD / BASIC the default', () => {
    const { sd } = adapter([]);
    expect(sd.modelFor(5, 'PLUS')).toBe('dreamina-seedance-2-5-260628');
    expect(sd.modelFor(5, 'ENTERPRISE')).toBe('dreamina-seedance-2-5-260628');
    expect(sd.modelFor(5, 'STANDARD')).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.modelFor(5, 'BASIC')).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.modelFor(5)).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.buildBody({ ...t2v, planTier: 'PLUS' })).toMatchObject({
      model: 'dreamina-seedance-2-5-260628',
      duration: 5,
      ratio: '9:16',
    });
    // 5 s 9:16 on 2.5: 108,000 tokens × $10.7/M = $1.1556 → 86.67p → 87p
    expect(sd.estimateCostPence({ ...t2v, planTier: 'PLUS' })).toBe(87);
  });

  it('PLUS with a 15 s long model: that model up to 15 s, nothing for 20 s', () => {
    const { sd } = adapter([], { longModel: 'dreamina-seedance-2-0-260128' });
    expect(sd.modelFor(10, 'PLUS')).toBe('dreamina-seedance-2-0-260128');
    expect(sd.modelFor(20, 'PLUS')).toBeUndefined();
  });

  it('a long-capable default model needs no long model', () => {
    const { sd } = adapter([], { model: 'dreamina-seedance-2-5-260628' });
    expect(sd.modelFor(20)).toBe('dreamina-seedance-2-5-260628');
  });
});

describe('supportsRequest (router hint)', () => {
  const { sd } = adapter([]);
  it.each([
    [1, true],
    [10, true],
    [15, true],
    [16, true],
    [30, true],
    [31, false],
  ])('a %ss shot → %s', (durationSec, ok) => {
    expect(sd.supportsRequest({ ...t2v, durationSec })).toBe(ok);
  });

  it('only video capabilities', () => {
    expect(sd.supportsRequest(i2v)).toBe(true);
    expect(
      sd.supportsRequest({
        capability: 'text_to_image',
        organisationId: 'o',
        prompt: 'p',
        aspectRatio: '1:1',
      }),
    ).toBe(false);
  });

  it('with a 15 s long model too, shots over 15 s are skipped', () => {
    const { sd: short } = adapter([], { longModel: 'dreamina-seedance-2-0-fast-260128' });
    expect(short.supportsRequest({ ...t2v, durationSec: 16 })).toBe(false);
  });
});

describe('seedanceOptionsFromEnv', () => {
  it('empty values leave the adapter defaults', () => {
    expect(seedanceOptionsFromEnv({})).toEqual({});
    expect(
      seedanceOptionsFromEnv({
        SEEDANCE_MODEL: ' ',
        SEEDANCE_LONG_MODEL: '',
        BYTEPLUS_ARK_BASE_URL: '',
      }),
    ).toEqual({});
  });

  it('reads documented models and a ModelArk base URL', () => {
    expect(
      seedanceOptionsFromEnv({
        SEEDANCE_MODEL: 'dreamina-seedance-2-0-fast-260128',
        SEEDANCE_LONG_MODEL: 'dreamina-seedance-2-5-260628',
        BYTEPLUS_ARK_BASE_URL: 'https://ark.eu-west.bytepluses.com/api/v3/',
      }),
    ).toEqual({
      model: 'dreamina-seedance-2-0-fast-260128',
      longModel: 'dreamina-seedance-2-5-260628',
      baseUrl: 'https://ark.eu-west.bytepluses.com/api/v3',
    });
  });

  it.each([
    ['SEEDANCE_MODEL', 'seedance-1-5-pro-251215'], // retired, no price row
    ['SEEDANCE_LONG_MODEL', 'dreamina-seedance-9'],
    ['BYTEPLUS_ARK_BASE_URL', 'https://evil.example/api/v3'],
    ['BYTEPLUS_ARK_BASE_URL', 'http://ark.ap-southeast.bytepluses.com/api/v3'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => seedanceOptionsFromEnv({ [key]: value })).toThrow(ConfigurationError);
  });

  it('isArkBaseUrl accepts only ModelArk data-plane URLs', () => {
    expect(isArkBaseUrl(DEFAULT_BASE_URL)).toBe(true);
    expect(isArkBaseUrl('https://ark.ap-southeast.bytepluses.com/api/v3?x=1')).toBe(false);
    expect(isArkBaseUrl('https://ark.ap-southeast.bytepluses.com/other')).toBe(false);
    expect(isArkBaseUrl('not a url')).toBe(false);
  });
});

describe('cost estimate (list prices, 720p, tokens = s × w × h × 24 / 1024)', () => {
  it('token formula matches the pricing page example (2.0, 720p 16:9, 5 s → 108,000)', () => {
    expect(seedanceTokens(5, 1280 * 720)).toBe(108_000);
  });

  it.each([
    // model, seconds, USD → pence at 0.75 (rounded up)
    ['dreamina-seedance-2-0-mini-260615', 4, 86_400 * 3.5],
    ['dreamina-seedance-2-0-fast-260128', 4, 86_400 * 5.6],
    ['dreamina-seedance-2-0-260128', 4, 86_400 * 7.0],
    ['dreamina-seedance-2-5-260628', 4, 86_400 * 10.7],
  ] as const)('%s, 4 s 9:16', (model, seconds, microUsd) => {
    const { sd } = adapter([], { model });
    const expected = Math.ceil(Number(((microUsd / 1e6) * 0.75 * 100).toFixed(6)));
    expect(sd.estimateCostPence({ ...t2v, durationSec: seconds })).toBe(expected);
  });

  it('bills the rendered length (5.2 s → 6 s) and the long model above 15 s', () => {
    const { sd } = adapter([]);
    // 6 s mini: 129,600 tokens × $3.5/M = $0.4536 → 34.02p → 35p
    expect(sd.estimateCostPence({ ...t2v, durationSec: 5.2 })).toBe(35);
    // 20 s on 2.5: 432,000 tokens × $10.7/M = $4.6224 → 346.68p → 347p
    expect(sd.estimateCostPence({ ...t2v, durationSec: 20 })).toBe(347);
  });

  it('4:5 is priced as 3:4 (834×1112); unsupported requests cost nothing', () => {
    const { sd } = adapter([]);
    const tokens = seedanceTokens(4, 834 * 1112);
    const expected = Math.ceil(Number((((tokens * 3.5) / 1e6) * 0.75 * 100).toFixed(6)));
    expect(sd.estimateCostPence({ ...t2v, durationSec: 4, aspectRatio: '4:5' })).toBe(expected);
    expect(sd.estimateCostPence({ ...t2v, durationSec: 40 })).toBe(0);
  });
});

describe('SeedanceAdapter.submit', () => {
  it('posts the task with Bearer auth, 720p, the mapped ratio/duration and audio off', async () => {
    const { sd, requests } = adapter([json({ id: TASK })]);
    const submitted = await sd.submit(t2v);
    expect(requests[0]).toMatchObject({
      url: TASKS,
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: {
        model: 'dreamina-seedance-2-0-mini-260615',
        content: [{ type: 'text', text: 'Steam rising from fresh bread' }],
        ratio: '9:16',
        duration: 5,
        resolution: '720p',
        generate_audio: false,
        watermark: false,
        execution_expires_after: 3600,
        safety_identifier: createHash('sha256').update('org-1').digest('hex'),
      },
    });
    expect(submitted).toEqual({
      providerJobId: TASK,
      estimatedCostPence: sd.estimateCostPence(t2v),
      estimatedReadyAt: new Date(NOW + 120_000),
    });
  });

  it('never sends seed / camera_fixed (not supported by the 2.x models)', () => {
    const { sd } = adapter([]);
    const body = sd.buildBody(t2v);
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('camera_fixed');
  });

  it('a 2 s shot asks for 4 s (the minimum), a 20 s shot uses the long model', () => {
    const { sd } = adapter([]);
    expect(sd.buildBody({ ...t2v, durationSec: 2 })).toMatchObject({ duration: 4 });
    expect(sd.buildBody({ ...t2v, durationSec: 20 })).toMatchObject({
      model: DEFAULT_SEEDANCE_LONG_MODEL,
      duration: 20,
    });
  });

  it('image-to-video sends the frame URL as first_frame with the mapped ratio', () => {
    const { sd } = adapter([]);
    expect(sd.buildBody({ ...i2v, aspectRatio: '4:5' })).toMatchObject({
      content: [
        { type: 'text', text: 'Steam rising from fresh bread' },
        {
          type: 'image_url',
          image_url: { url: 'https://cdn.example/frame.png' },
          role: 'first_frame',
        },
      ],
      ratio: '3:4',
    });
  });

  it('image-to-video on 2.5 sends ratio "adaptive" (the only value it accepts)', () => {
    const { sd } = adapter([], { model: 'dreamina-seedance-2-5-260628' });
    expect(sd.buildBody(i2v)).toMatchObject({ ratio: 'adaptive' });
    expect(sd.buildBody(t2v)).toMatchObject({ ratio: '9:16' });
  });

  it.each([
    ['a non-https frame', { ...i2v, imageUrl: 'http://cdn.example/f.png' }],
    ['a frame that is not a URL', { ...i2v, imageUrl: 'frame.png' }],
    ['an empty prompt', { ...t2v, prompt: '   ' }],
    ['a 31 s shot', { ...t2v, durationSec: 31 }],
    [
      'another capability',
      {
        capability: 'text_to_image' as const,
        organisationId: 'o',
        prompt: 'p',
        aspectRatio: '1:1' as const,
      },
    ],
  ])('refuses %s as invalid_request without calling BytePlus', async (_name, request) => {
    const { sd, requests } = adapter([]);
    await expect(sd.submit(request)).rejects.toMatchObject({
      providerId: 'seedance',
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });

  it('a response without a task id is a retryable unknown error', async () => {
    const { sd } = adapter([json({})]);
    await expect(sd.submit(t2v)).rejects.toMatchObject({ errorClass: 'unknown', retryable: true });
  });

  it('uses BYTEPLUS_ARK_BASE_URL when set', async () => {
    const base = 'https://ark.eu-west.bytepluses.com/api/v3';
    const { sd, requests } = adapter([json({ id: TASK })], { baseUrl: base });
    await sd.submit(t2v);
    expect(requests[0]?.url).toBe(`${base}/contents/generations/tasks`);
  });
});

describe('SeedanceAdapter.poll', () => {
  it('submit → queued → running → succeeded with the video URL and the billed cost', async () => {
    const { sd, requests } = adapter([
      json({ id: TASK }),
      json(task('queued')),
      json(task('running')),
      json(
        task('succeeded', {
          content: { video_url: VIDEO_URL },
          usage: { completion_tokens: 108_000, total_tokens: 108_000 },
          duration: 5,
          ratio: '9:16',
          resolution: '720p',
          framespersecond: 24,
          generate_audio: false,
        }),
      ),
    ]);
    const { providerJobId } = await sd.submit(t2v);
    expect(await sd.poll(providerJobId)).toEqual({ state: 'running' });
    expect(await sd.poll(providerJobId)).toEqual({ state: 'running' });
    const done = await sd.poll(providerJobId);
    expect(requests[1]).toMatchObject({
      url: `${TASKS}/${TASK}`,
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
    });
    // 108,000 tokens × $3.5/M = $0.378 → 28.35p → 29p
    expect(done).toEqual({
      state: 'succeeded',
      output: {
        url: VIDEO_URL,
        metadata: expect.objectContaining({
          taskId: TASK,
          model: DEFAULT_SEEDANCE_MODEL,
          completionTokens: 108_000,
          costPence: 29,
          urlExpiresWithinHours: 24,
        }),
      },
    });
  });

  it('an unknown model in the task keeps the submit estimate (no costPence)', async () => {
    const { sd } = adapter([
      json(
        task('succeeded', {
          model: 'dreamina-seedance-3-0-xyz',
          content: { video_url: VIDEO_URL },
          usage: { completion_tokens: 100 },
        }),
      ),
    ]);
    const done = await sd.poll(TASK);
    expect(done.state).toBe('succeeded');
    expect(done.output?.metadata).not.toHaveProperty('costPence');
  });

  it('succeeded without an https video URL is a retryable failure', async () => {
    const { sd } = adapter([json(task('succeeded', { content: { video_url: 'ftp://x' } }))]);
    expect(await sd.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
  });

  it('a failed task with a moderation code → content_policy (not billed)', async () => {
    const { sd } = adapter([
      json(
        task('failed', {
          error: {
            code: 'OutputVideoSensitiveContentDetected',
            message:
              'The request failed because the output video may contain sensitive information.',
          },
        }),
      ),
    ]);
    expect(await sd.poll(TASK)).toEqual({
      state: 'failed',
      error: {
        class: 'content_policy',
        retryable: false,
        message:
          'OutputVideoSensitiveContentDetected: The request failed because the output video may contain sensitive information.',
      },
    });
  });

  it('a failed task with out-of-credit wording is an account problem', async () => {
    const { sd } = adapter([
      json(
        task('failed', { error: { code: 'Weird', message: 'Insufficient balance on account' } }),
      ),
    ]);
    expect(await sd.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'insufficient_credits', retryable: false },
    });
  });

  it('expired → retryable timeout; cancelled → unknown; an unknown status → retryable', async () => {
    const { sd } = adapter([json(task('expired')), json(task('cancelled')), json(task('paused'))]);
    expect(await sd.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'timeout', retryable: true },
    });
    expect(await sd.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: false },
    });
    expect(await sd.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
  });

  it('a 404 (records are kept 7 days) → result_expired', async () => {
    const { sd } = adapter([arkError('NotFound.', 'The specified task is not found.', 404)]);
    expect(await sd.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('refuses a malformed task id without calling BytePlus', async () => {
    const { sd, requests } = adapter([]);
    expect(await sd.poll('../x')).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request' },
    });
    expect(requests).toHaveLength(0);
  });

  it('a 401 while polling throws an auth ProviderError', async () => {
    const { sd } = adapter([
      arkError(
        'AuthenticationError',
        'The API key or AK/SK in the request is missing or invalid.',
        401,
      ),
    ]);
    await expect(sd.poll(TASK)).rejects.toMatchObject({ errorClass: 'auth', retryable: false });
  });
});

describe('error classes (ModelArk error codes)', () => {
  it.each([
    // HTTP status, code, message, class, retryable
    [401, 'AuthenticationError', 'invalid key', 'auth', false],
    [401, 'InvalidAccountStatus', 'account status', 'auth', false],
    [403, 'AccessDenied', 'no access', 'auth', false],
    [403, 'OperationDenied.ServiceNotOpen', 'activate the model', 'auth', false],
    [404, 'ModelNotOpen', 'has not activated the model', 'auth', false],
    [404, 'InvalidEndpointOrModel.NotFound', 'does not exist', 'auth', false],
    [403, 'AccountOverdueError', 'overdue balance', 'insufficient_credits', false],
    [403, 'OperationDenied.ServiceOverdue', 'bill is overdue', 'insufficient_credits', false],
    [
      429,
      'QuotaExceeded',
      'exhausted its free trial quota for the model',
      'insufficient_credits',
      false,
    ],
    [
      429,
      'QuotaExceeded',
      'You have exceeded the 5-hour/weekly/monthly usage quota.',
      'account_limit',
      false,
    ],
    [429, 'QuotaExceeded', 'The request has exceeded the quota.', 'rate_limited', true],
    [429, 'SetLimitExceeded', 'model service has been paused', 'account_limit', false],
    [429, 'ModelAccountRpmRateLimitExceeded', 'RPM', 'rate_limited', true],
    [429, 'RateLimitExceeded.EndpointRPMExceeded', 'RPM', 'rate_limited', true],
    [429, 'RequestBurstTooFast', 'slow down', 'rate_limited', true],
    [429, 'InflightBatchsizeExceeded', 'concurrency', 'rate_limited', true],
    [429, 'ServerOverloaded', 'overload', 'provider_unavailable', true],
    [500, 'InternalServiceError', 'internal', 'provider_unavailable', true],
    [400, 'InvalidEndpoint.ClosedEndpoint', 'closed', 'provider_unavailable', true],
    [400, 'InputTextSensitiveContentDetected', 'sensitive', 'content_policy', false],
    [
      400,
      'InputImageSensitiveContentDetected.PrivacyInformation',
      'real person',
      'content_policy',
      false,
    ],
    [
      400,
      'OutputVideoSensitiveContentDetected.PolicyViolation',
      'copyright',
      'content_policy',
      false,
    ],
    [400, 'InvalidParameter', 'bad ratio', 'invalid_request', false],
    [400, 'InvalidParameter.TaskTypeConstraint', 'bad', 'invalid_request', false],
    [400, 'MissingParameter.', 'missing', 'invalid_request', false],
    [400, 'InvalidImageURL.InvalidFormat', 'bad image', 'invalid_request', false],
    // Unknown codes fall back to the status; out-of-credit / arrears wording is an account problem.
    [400, 'SomethingNew', 'not enough credits to run this task', 'insufficient_credits', false],
    [400, 'InvalidParameter', 'your account is in arrears', 'insufficient_credits', false],
    [400, 'SomethingNew', 'nope', 'invalid_request', false],
    [503, 'SomethingNew', 'down', 'provider_unavailable', true],
  ] as const)('%s %s (%s) → %s', (status, code, message, cls, retryable) => {
    expect(classifySeedanceHttpError(status, { error: { code, message, type: 'x' } })).toEqual({
      errorClass: cls,
      retryable,
    });
  });

  it('a body without an error object uses the status', () => {
    expect(classifySeedanceHttpError(402, 'Payment Required')).toEqual({
      errorClass: 'insufficient_credits',
      retryable: false,
    });
    expect(classifySeedanceHttpError(429, undefined)).toEqual({
      errorClass: 'rate_limited',
      retryable: true,
    });
  });

  it('unknown codes are undefined to classifyArkCode; task errors default to unknown', () => {
    expect(classifyArkCode('Brand.New', 'x')).toBeUndefined();
    expect(classifyTaskError({ code: 'Brand.New', message: 'x' })).toEqual({
      class: 'unknown',
      retryable: false,
    });
    expect(classifyTaskError({})).toEqual({ class: 'unknown', retryable: false });
  });

  it('submit surfaces the class and the raw message stays internal to the ProviderError', async () => {
    const { sd } = adapter([
      arkError(
        'AccountOverdueError',
        'The request failed because your account has an overdue balance.',
        403,
      ),
    ]);
    const err = await sd.submit(t2v).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      providerId: 'seedance',
      errorClass: 'insufficient_credits',
      retryable: false,
      message:
        'AccountOverdueError: The request failed because your account has an overdue balance.',
    });
  });
});

describe('SeedanceAdapter.cancel / healthCheck', () => {
  it('cancels a queued task with DELETE', async () => {
    const { sd, requests } = adapter([json(task('queued')), json({})]);
    await sd.cancel(TASK);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', `${TASKS}/${TASK}`],
      ['DELETE', `${TASKS}/${TASK}`],
    ]);
  });

  it('a running task cannot be cancelled (documented) → NotImplementedError', async () => {
    const { sd, requests } = adapter([json(task('running'))]);
    await expect(sd.cancel(TASK)).rejects.toBeInstanceOf(NotImplementedError);
    expect(requests).toHaveLength(1);
  });

  it('a finished or vanished task needs no cancel', async () => {
    const { sd, requests } = adapter([
      json(task('succeeded', { content: { video_url: VIDEO_URL } })),
      arkError('NotFound.', 'gone', 404),
    ]);
    await sd.cancel(TASK);
    await sd.cancel(TASK);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('health = list one task (unbilled), Bearer auth', async () => {
    const { sd, requests } = adapter([json({ total: 0, items: [] })]);
    expect(await sd.healthCheck()).toEqual({ healthy: true });
    expect(requests[0]).toMatchObject({
      url: `${TASKS}?page_num=1&page_size=1`,
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
    });
  });

  it('reports the error class when the key is refused', async () => {
    const { sd } = adapter([arkError('AuthenticationError', 'invalid', 401)]);
    expect(await sd.healthCheck()).toEqual({
      healthy: false,
      reason: 'auth: AuthenticationError: invalid',
    });
  });
});

describe('kill switch (spec 6.7 level 4) and BYOC', () => {
  it('Seedance has its own provider kill-switch flag, seeded off', () => {
    expect(PROVIDER_IDS).toContain('seedance');
    expect(defaultSystemFlags()).toContainEqual({
      key: 'studio.disabledProvider.seedance',
      value: 'false',
    });
  });

  it('an organisation may bring its own BytePlus key', () => {
    expect(BYOC_PROVIDER_IDS).toContain('seedance');
    expect(byocProvider('seedance').adapters).toEqual(['seedance']);
  });
});
