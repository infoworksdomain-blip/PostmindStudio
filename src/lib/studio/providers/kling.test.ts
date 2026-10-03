import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, NotImplementedError, ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { defaultSystemFlags, PROVIDER_IDS } from '../system-flags';
import {
  classifyKlingHttpError,
  classifyTaskFailure,
  isKlingBaseUrl,
  klingCredentialsFrom,
  signKlingJwt,
  KlingAdapter,
  klingDuration,
  klingOptionsFromEnv,
  KLING_RATIO,
} from './kling';

// Fixtures follow kling.ai/document-api/api/video/3-0-omni/{text,image}-to-video (create task +
// GET /tasks?task_ids=), the Error Codes page and the Account Usage page (read 2026-10-02).
// No real API is called.
const NOW = Date.parse('2026-10-02T12:00:00Z');
const KEY = 'FAKE-kling-api-key-0123456789';
const TASK = '893605946402811985';
const BASE = 'https://api-singapore.klingai.com';
const VIDEO_URL = 'https://v1-kling.klingai.com/kcdn/output/893605946402811985.mp4';

function adapter(
  replies: Parameters<typeof fakeFetch>,
  options: Partial<ConstructorParameters<typeof KlingAdapter>[0]> = {},
) {
  const fake = fakeFetch(...replies);
  return {
    kling: new KlingAdapter({
      credentials: { kind: 'api_key', apiKey: KEY },
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

const created = (status = 'submitted') => ({
  code: 0,
  message: 'SUCCEED',
  request_id: 'req-1',
  data: { id: TASK, status, create_time: NOW, update_time: NOW },
});

const task = (fields: Record<string, unknown>) => ({
  code: 0,
  message: 'SUCCEED',
  request_id: 'req-2',
  data: [{ id: TASK, create_time: NOW, update_time: NOW, ...fields }],
});

const succeeded = (billing: unknown[] = []) =>
  task({
    status: 'succeeded',
    outputs: [{ type: 'video', id: 'v1', url: VIDEO_URL, watermark_url: '', duration: '5.1' }],
    billing,
  });

describe('format mapping', () => {
  it.each([
    [1, 3],
    [2.5, 3],
    [3, 3],
    [5, 5],
    [5.2, 6],
    [10, 10],
    [15, 15],
  ])('a %ss shot renders as a %ss clip (whole seconds, at least 3)', (shot, clip) => {
    expect(klingDuration(shot)).toBe(clip);
  });

  it('maps 16:9, 9:16 and 1:1 directly and 4:5 to portrait', () => {
    expect(KLING_RATIO).toEqual({ '9:16': '9:16', '16:9': '16:9', '1:1': '1:1', '4:5': '9:16' });
  });
});

describe('credentials: API key or the legacy AccessKey/SecretKey JWT', () => {
  const decode = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

  it('signs a deterministic HS256 JWT { iss, exp: now + 1800, nbf: now - 5 }', () => {
    const token = signKlingJwt('AK-test', 'SK-test', NOW + 999);
    const [header, payload, signature] = token.split('.');
    expect(decode(header ?? '')).toEqual({ alg: 'HS256', typ: 'JWT' });
    const now = NOW / 1000;
    expect(decode(payload ?? '')).toEqual({ iss: 'AK-test', exp: now + 1800, nbf: now - 5 });
    const expected = createHmac('sha256', 'SK-test')
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    // Same inputs, same token; another secret, another signature.
    expect(signKlingJwt('AK-test', 'SK-test', NOW + 999)).toBe(token);
    expect(signKlingJwt('AK-test', 'SK-other', NOW).split('.')[2]).not.toBe(signature);
  });

  it('prefers the API key, else the complete pair, else nothing', () => {
    expect(klingCredentialsFrom({ apiKey: ' k ', accessKey: 'a', secretKey: 's' })).toEqual({
      kind: 'api_key',
      apiKey: 'k',
    });
    expect(klingCredentialsFrom({ accessKey: 'a', secretKey: 's' })).toEqual({
      kind: 'access_key',
      accessKey: 'a',
      secretKey: 's',
    });
    expect(klingCredentialsFrom({})).toBeUndefined();
    expect(klingCredentialsFrom({ apiKey: '  ' })).toBeUndefined();
  });

  it('half a legacy pair is a configuration error', () => {
    expect(() => klingCredentialsFrom({ accessKey: 'a' })).toThrow(ConfigurationError);
    expect(() => klingCredentialsFrom({ secretKey: 's' })).toThrow(ConfigurationError);
  });

  it('a legacy pair sends a fresh JWT as the Bearer token', async () => {
    const fake = fakeFetch(json(created()));
    const kling = new KlingAdapter({
      credentials: { kind: 'access_key', accessKey: 'AK-test', secretKey: 'SK-test' },
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
    });
    expect(kling.authKind).toBe('access_key');
    await kling.submit(t2v);
    expect(fake.requests[0]?.headers.authorization).toBe(
      `Bearer ${signKlingJwt('AK-test', 'SK-test', NOW)}`,
    );
    expect(JSON.stringify(fake.requests[0])).not.toContain('SK-test');
  });
});

describe('klingOptionsFromEnv', () => {
  it('empty values leave the adapter defaults', () => {
    expect(klingOptionsFromEnv({})).toEqual({});
    expect(
      klingOptionsFromEnv({ KLING_MODEL: ' ', KLING_RESOLUTION: '', KLING_BASE_URL: '' }),
    ).toEqual({});
  });

  it('reads a documented model, resolution and base URL', () => {
    expect(
      klingOptionsFromEnv({
        KLING_MODEL: 'kling-3.0',
        KLING_RESOLUTION: '1080p',
        KLING_BASE_URL: 'https://api-singapore.klingai.com/',
      }),
    ).toEqual({
      model: 'kling-3.0',
      resolution: '1080p',
      baseUrl: 'https://api-singapore.klingai.com',
    });
  });

  it.each([
    ['KLING_MODEL', 'kling-v2-6'],
    ['KLING_RESOLUTION', '4k'],
    ['KLING_RESOLUTION', 'pro'],
    ['KLING_BASE_URL', 'http://api-singapore.klingai.com'],
    ['KLING_BASE_URL', 'https://api-singapore.klingai.com/v1'],
    ['KLING_BASE_URL', 'not a url'],
  ])('%s=%s is a configuration error', (key, value) => {
    expect(() => klingOptionsFromEnv({ [key]: value })).toThrow(ConfigurationError);
  });

  it('isKlingBaseUrl accepts only an https origin', () => {
    expect(isKlingBaseUrl('https://api.klingai.com')).toBe(true);
    expect(isKlingBaseUrl('https://user:pw@api.klingai.com')).toBe(false);
    expect(isKlingBaseUrl('https://api.klingai.com?x=1')).toBe(false);
  });
});

describe('KlingAdapter.submit', () => {
  it('posts text-to-video with the API key, no audio, one shot, 720p and the mapped settings', async () => {
    const { kling, requests } = adapter([json(created())]);
    const submitted = await kling.submit(t2v);
    expect(requests[0]).toEqual({
      url: `${BASE}/text-to-video/kling-3.0`,
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: {
        prompt: 'Steam rising from fresh bread',
        settings: {
          multi_shot: false,
          audio: 'off',
          resolution: '720p',
          duration: 5,
          aspect_ratio: '9:16',
        },
        options: { watermark_info: { enabled: false } },
      },
    });
    // Kling 3.0 silent 720p $0.084/s × 5 s = $0.42 × 0.75 = 31.5p → 32p
    expect(submitted).toEqual({
      providerJobId: TASK,
      estimatedCostPence: 32,
      estimatedReadyAt: new Date(NOW + 180_000),
    });
  });

  it('never asks for native audio, whatever the shot', async () => {
    const { kling, requests } = adapter([json(created()), json(created())]);
    await kling.submit({ ...t2v, durationSec: 15, aspectRatio: '16:9' });
    await kling.submit({
      ...t2v,
      capability: 'image_to_video',
      imageUrl: 'https://cdn.example/frame.png',
    });
    for (const request of requests) {
      expect(request.body).toMatchObject({ settings: { audio: 'off', multi_shot: false } });
      expect(JSON.stringify(request.body)).not.toContain('native');
    }
  });

  it('uses the configured resolution and base URL', async () => {
    const { kling, requests } = adapter([json(created())], {
      resolution: '1080p',
      baseUrl: 'https://api.klingai.com',
    });
    const submitted = await kling.submit({ ...t2v, durationSec: 10, aspectRatio: '1:1' });
    expect(requests[0]?.url).toBe('https://api.klingai.com/text-to-video/kling-3.0');
    expect(requests[0]?.body).toMatchObject({
      settings: { resolution: '1080p', duration: 10, aspect_ratio: '1:1' },
    });
    // 1080p $0.112/s × 10 s = $1.12 × 0.75 = 84p
    expect(submitted.estimatedCostPence).toBe(84);
  });

  it('sends image-to-video as prompt + first_frame contents, without an aspect ratio', async () => {
    const { kling, requests } = adapter([json(created())]);
    await kling.submit({
      ...t2v,
      capability: 'image_to_video',
      imageUrl: 'https://cdn.example/frame.png?X-Amz-Signature=abc',
      durationSec: 7.4,
      aspectRatio: '4:5',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${BASE}/image-to-video/kling-3.0`,
      body: {
        contents: [
          { type: 'prompt', text: 'Steam rising from fresh bread' },
          { type: 'first_frame', url: 'https://cdn.example/frame.png?X-Amz-Signature=abc' },
        ],
        settings: { multi_shot: false, audio: 'off', resolution: '720p', duration: 8 },
        options: { watermark_info: { enabled: false } },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('aspect_ratio');
  });

  it('refuses non-https frames, shots over 15 s, bad prompts and other capabilities', async () => {
    const { kling, requests } = adapter([]);
    const i2v = { ...t2v, capability: 'image_to_video' as const };
    await expect(
      kling.submit({ ...i2v, imageUrl: 'http://cdn.example/a.png' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request', retryable: false });
    await expect(kling.submit({ ...i2v, imageUrl: 'frame.png' })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(kling.submit({ ...t2v, durationSec: 16 })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(kling.submit({ ...t2v, prompt: '   ' })).rejects.toBeInstanceOf(ProviderError);
    await expect(kling.submit({ ...t2v, prompt: 'x'.repeat(3073) })).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(
      kling.submit({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('fails retryably when Kling returns no usable task id', async () => {
    const { kling } = adapter([
      json({ code: 0, data: {} }),
      json({ code: 0, data: { id: '../x' } }),
    ]);
    await expect(kling.submit(t2v)).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
    await expect(kling.submit(t2v)).rejects.toMatchObject({ errorClass: 'unknown' });
  });
});

describe('KlingAdapter routing hints and cost', () => {
  it('supports 1–15 s clip shots only', () => {
    const { kling } = adapter([]);
    expect(kling.supportsRequest({ ...t2v, durationSec: 1 })).toBe(true);
    expect(kling.supportsRequest({ ...t2v, durationSec: 15 })).toBe(true);
    expect(kling.supportsRequest({ ...t2v, durationSec: 15.5 })).toBe(false);
    expect(kling.supportsRequest({ ...t2v, durationSec: 0.5 })).toBe(false);
    expect(
      kling.supportsRequest({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
    ).toBe(false);
  });

  it.each([
    ['720p', 1, 19], // 3 s minimum: $0.252 × 0.75 = 18.9p → 19p
    ['720p', 5, 32], // $0.42 → 31.5p → 32p
    ['720p', 15, 95], // $1.26 → 94.5p → 95p
    ['1080p', 5, 42], // $0.56 → 42p
    ['1080p', 15, 126], // $1.68 → 126p
  ] as const)('%s, %ss shot → %sp', (resolution, seconds, pence) => {
    const { kling } = adapter([], { resolution });
    expect(kling.estimateCostPence({ ...t2v, durationSec: seconds })).toBe(pence);
  });

  it('estimates 0 for capabilities it does not do', () => {
    const { kling } = adapter([]);
    expect(
      kling.estimateCostPence({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
    ).toBe(0);
  });
});

describe('KlingAdapter.poll', () => {
  it('submit → submitted → processing → succeeded → video URL', async () => {
    const { kling, requests } = adapter([
      json(created()),
      json(task({ status: 'submitted' })),
      json(task({ status: 'processing' })),
      json(succeeded()),
    ]);
    const { providerJobId } = await kling.submit(t2v);
    expect(await kling.poll(providerJobId)).toEqual({ state: 'running' });
    expect(await kling.poll(providerJobId)).toEqual({ state: 'running' });
    const result = await kling.poll(providerJobId);
    expect(requests[1]).toMatchObject({
      url: `${BASE}/tasks?task_ids=${TASK}`,
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(result).toEqual({
      state: 'succeeded',
      output: {
        url: VIDEO_URL,
        metadata: {
          taskId: TASK,
          model: 'kling-3.0',
          resolution: '720p',
          audio: 'off',
          durationSec: 5.1,
          urlExpiresWithinHours: 720,
        },
      },
    });
  });

  it.each([
    [[{ charge_type: 'unit', amount: '3', package_type: 'video' }], 32], // 3 × $0.14 = $0.42
    [[{ charge_type: 'cash', amount: '0.42', currency: 'USD', cash_type: 'balance' }], 32],
  ])('reports the billed cost %j as %sp', async (billing, pence) => {
    const { kling } = adapter([json(succeeded(billing))]);
    const result = await kling.poll(TASK);
    expect(result.output?.metadata).toMatchObject({ costPence: pence });
  });

  it('keeps the estimate when the bill is in CNY or unreadable', async () => {
    const { kling } = adapter([
      json(succeeded([{ charge_type: 'cash', amount: '3', currency: 'CNY' }])),
      json(succeeded([{ charge_type: 'unit', amount: 'n/a' }])),
    ]);
    expect((await kling.poll(TASK)).output?.metadata).not.toHaveProperty('costPence');
    expect((await kling.poll(TASK)).output?.metadata).not.toHaveProperty('costPence');
  });

  it('a failed task for content risk is a non-retryable content_policy failure', async () => {
    const message = 'Failure to pass the risk control system';
    const { kling } = adapter([json(task({ status: 'failed', message }))]);
    expect(await kling.poll(TASK)).toEqual({
      state: 'failed',
      error: { class: 'content_policy', message, retryable: false },
    });
  });

  it('any other failed task is a retryable unknown failure', async () => {
    const { kling } = adapter([json(task({ status: 'failed', message: 'generation error' }))]);
    expect(await kling.poll(TASK)).toEqual({
      state: 'failed',
      error: { class: 'unknown', message: 'generation error', retryable: true },
    });
  });

  it('succeeded without a video, an unknown status or a missing task fail clearly', async () => {
    const { kling } = adapter([
      json(task({ status: 'succeeded', outputs: [{ type: 'image', url: 'https://x/y.png' }] })),
      json(task({ status: 'paused' })),
      json({ code: 0, data: [] }),
    ]);
    expect(await kling.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
    expect(await kling.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
    expect(await kling.poll(TASK)).toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('refuses a job id that is not a Kling task id (no request)', async () => {
    const { kling, requests } = adapter([]);
    expect(await kling.poll('1&external_task_ids=2')).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request' },
    });
    expect(requests).toHaveLength(0);
  });
});

describe('error classification (20.11 / 20.19 classes)', () => {
  const body = (code: number, message: string) => ({ code, message, request_id: 'r' });

  it.each([
    [401, 1000, 'Authentication failed', 'auth', false],
    [401, 1002, 'Authorization is invalid', 'auth', false],
    [401, 1004, 'Authorization has expired', 'auth', false],
    [429, 1100, 'Abnormal account status', 'account_limit', false],
    [429, 1101, 'Account in arrears', 'insufficient_credits', false],
    [429, 1102, 'Resource pack exhausted', 'insufficient_credits', false],
    [403, 1103, 'Unauthorized access to model', 'auth', false],
    [400, 1200, 'Invalid request parameters', 'invalid_request', false],
    [400, 1201, 'duration is invalid', 'invalid_request', false],
    [404, 1203, 'model does not exist', 'invalid_request', false],
    [400, 1300, 'Request blocked by platform policy', 'content_policy', false],
    [400, 1301, 'content security policy', 'content_policy', false],
    [429, 1302, 'rate limit exceeded', 'rate_limited', true],
    [429, 1303, 'parallel task over resource pack limit', 'rate_limited', true],
    [429, 1304, 'IP whitelist policy', 'auth', false],
    [500, 5000, 'Server internal error', 'provider_unavailable', true],
    [503, 5001, 'maintenance', 'provider_unavailable', true],
    [504, 5002, 'internal timeout', 'timeout', true],
  ] as const)('HTTP %s code %s (%s) → %s', (status, code, message, cls, retryable) => {
    expect(classifyKlingHttpError(status, body(code, message))).toEqual({
      errorClass: cls,
      retryable,
    });
  });

  it('unknown codes fall back to the HTTP status', () => {
    expect(classifyKlingHttpError(502, body(9999, 'bad gateway')).errorClass).toBe(
      'provider_unavailable',
    );
    expect(classifyKlingHttpError(402, 'Payment Required').errorClass).toBe('insufficient_credits');
    expect(classifyKlingHttpError(400, body(9999, 'odd')).errorClass).toBe('invalid_request');
  });

  it('out-of-credit wording on an input error is an account problem (isOutOfCreditMessage)', () => {
    expect(classifyKlingHttpError(400, body(1201, 'Insufficient balance'))).toEqual({
      errorClass: 'insufficient_credits',
      retryable: false,
    });
    expect(classifyKlingHttpError(400, body(9999, 'You do not have enough credits'))).toEqual({
      errorClass: 'insufficient_credits',
      retryable: false,
    });
    // Not for retryable failures.
    expect(classifyKlingHttpError(503, body(5001, 'not enough credits')).errorClass).toBe(
      'provider_unavailable',
    );
  });

  it('failed-task messages: out of credit, content risk, anything else', () => {
    expect(classifyTaskFailure('insufficient balance on the account')).toEqual({
      class: 'insufficient_credits',
      retryable: false,
    });
    expect(classifyTaskFailure('Triggered the content risk control of the platform')).toEqual({
      class: 'content_policy',
      retryable: false,
    });
    expect(classifyTaskFailure('internal')).toEqual({ class: 'unknown', retryable: true });
  });

  it('a submit failure is a ProviderError with the status, code and Kling message', async () => {
    const { kling } = adapter([json(body(1102, 'resource pack exhausted'), 429)]);
    const err = await kling.submit(t2v).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      providerId: 'kling',
      errorClass: 'insufficient_credits',
      retryable: false,
      message: '1102: resource pack exhausted',
      details: expect.objectContaining({ status: 429 }),
    });
  });

  it('a 200 whose envelope code is not 0 is an error too', async () => {
    const { kling } = adapter([json(body(1303, 'parallel task over resource pack limit'))]);
    await expect(kling.submit(t2v)).rejects.toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
      details: { status: 200, code: 1303 },
    });
  });

  it('a poll that hits an auth error throws for the job runner', async () => {
    const { kling } = adapter([json(body(1004, 'Authorization has expired'), 401)]);
    await expect(kling.poll(TASK)).rejects.toMatchObject({ errorClass: 'auth' });
  });
});

describe('KlingAdapter.cancel / healthCheck', () => {
  it('cancel is honest: no documented cancel for Kling tasks', async () => {
    const { kling } = adapter([]);
    await expect(kling.cancel(TASK)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('health = the free account-usage query over the last 30 days', async () => {
    const { kling, requests } = adapter([
      json({ code: 0, data: { code: 0, resource_pack_subscribe_infos: [] } }),
    ]);
    expect(await kling.healthCheck()).toEqual({ healthy: true });
    const thirtyDays = 30 * 24 * 3600 * 1000;
    expect(requests[0]).toMatchObject({
      url: `${BASE}/account/costs?start_time=${NOW - thirtyDays}&end_time=${NOW}`,
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
    });
  });

  it('reports the error class when the key is refused', async () => {
    const { kling } = adapter([json({ code: 1002, message: 'Authorization is invalid' }, 401)]);
    expect(await kling.healthCheck()).toEqual({
      healthy: false,
      reason: 'auth: 1002: Authorization is invalid',
    });
  });
});

describe('kill switch (spec 6.7 level 4)', () => {
  it('Kling has its own provider kill-switch flag, seeded off', () => {
    expect(PROVIDER_IDS).toContain('kling');
    expect(defaultSystemFlags()).toContainEqual({
      key: 'studio.disabledProvider.kling',
      value: 'false',
    });
  });
});
