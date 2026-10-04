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
  DEFAULT_SEEDANCE_FULL_MODEL,
  DEFAULT_SEEDANCE_LONG_MODEL,
  DEFAULT_SEEDANCE_MODEL,
  FULL_MODEL_RETRY_AFTER_MS,
  isArkBaseUrl,
  SeedanceAdapter,
  seedanceDuration,
  seedanceFramePixels,
  seedanceOptionsFromEnv,
  seedanceResolution,
  seedanceTokens,
  seedanceUsdPerMillionTokens,
  SEEDANCE_MODELS,
  SEEDANCE_RATIO,
  SEEDANCE_TIER_MODEL,
  type SeedanceFallbackEvent,
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

  it('21.3: BASIC (and no tier) on 2.0 mini; STANDARD, PLUS and ENTERPRISE on the full 2.0', () => {
    const { sd } = adapter([]);
    expect(sd.model).toBe(DEFAULT_SEEDANCE_MODEL);
    expect(sd.fullModel).toBe('dreamina-seedance-2-0-260128');
    expect(DEFAULT_SEEDANCE_FULL_MODEL).toBe('dreamina-seedance-2-0-260128');
    expect(SEEDANCE_TIER_MODEL).toEqual({
      BASIC: 'default',
      STANDARD: 'full',
      PLUS: 'full',
      ENTERPRISE: 'full',
    });
    expect(sd.modelFor(4)).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.modelFor(4, 'BASIC')).toBe('dreamina-seedance-2-0-mini-260615');
    for (const planTier of ['STANDARD', 'PLUS', 'ENTERPRISE'] as const) {
      expect(sd.modelFor(4, planTier)).toBe('dreamina-seedance-2-0-260128');
      expect(sd.modelFor(15, planTier)).toBe('dreamina-seedance-2-0-260128');
      // 2.0 stops at 15 s like Mini: 16–30 s shots stay on 2.5 on every tier.
      expect(sd.modelFor(16, planTier)).toBe('dreamina-seedance-2-5-260628');
      expect(sd.modelFor(31, planTier)).toBeUndefined();
    }
  });

  it('21.3 request body per tier: model and the tier resolution (480p / 720p / 1080p)', () => {
    const { sd } = adapter([]);
    const shot = { ...t2v, durationSec: 4 };
    expect(sd.buildBody({ ...shot, planTier: 'BASIC', resolution: '480p' })).toMatchObject({
      model: 'dreamina-seedance-2-0-mini-260615',
      resolution: '480p',
      duration: 4,
      ratio: '9:16',
    });
    expect(sd.buildBody({ ...shot, planTier: 'STANDARD', resolution: '720p' })).toMatchObject({
      model: 'dreamina-seedance-2-0-260128',
      resolution: '720p',
    });
    for (const planTier of ['PLUS', 'ENTERPRISE'] as const) {
      expect(sd.buildBody({ ...shot, planTier, resolution: '1080p' })).toMatchObject({
        model: 'dreamina-seedance-2-0-260128',
        resolution: '1080p',
        duration: 4,
        ratio: '9:16',
        generate_audio: false,
      });
    }
    // A 20 s PLUS shot goes to 2.5, which also offers 1080p.
    expect(
      sd.buildBody({ ...t2v, durationSec: 20, planTier: 'PLUS', resolution: '1080p' }),
    ).toMatchObject({ model: 'dreamina-seedance-2-5-260628', resolution: '1080p' });
  });

  it('21.3 resolution is capped at what the model offers (mini / fast stop at 720p)', () => {
    const plus = { ...t2v, planTier: 'PLUS' as const, resolution: '1080p' as const };
    expect(seedanceResolution(plus, 'dreamina-seedance-2-0-260128')).toBe('1080p');
    expect(seedanceResolution(plus, 'dreamina-seedance-2-0-mini-260615')).toBe('720p');
    expect(seedanceResolution(plus, 'dreamina-seedance-2-0-fast-260128')).toBe('720p');
    expect(seedanceResolution({ ...t2v }, 'dreamina-seedance-2-0-260128')).toBe('720p');
    expect(SEEDANCE_MODELS['dreamina-seedance-2-0-mini-260615'].resolutions).toEqual([
      '480p',
      '720p',
    ]);
    // SEEDANCE_FULL_MODEL set back to Mini: PLUS asks Mini for 720p.
    const { sd } = adapter([], { fullModel: 'dreamina-seedance-2-0-mini-260615' });
    expect(sd.buildBody(plus)).toMatchObject({
      model: 'dreamina-seedance-2-0-mini-260615',
      resolution: '720p',
    });
  });

  it('1080p frames (create-task pixel table, read 2026-10-04)', () => {
    expect(seedanceFramePixels('dreamina-seedance-2-0-260128', '9:16', '1080p')).toBe(1080 * 1920);
    expect(seedanceFramePixels('dreamina-seedance-2-0-260128', '16:9', '1080p')).toBe(1920 * 1080);
    expect(seedanceFramePixels('dreamina-seedance-2-0-260128', '1:1', '1080p')).toBe(1440 * 1440);
    expect(seedanceFramePixels('dreamina-seedance-2-0-260128', '3:4', '1080p')).toBe(1248 * 1664);
    expect(seedanceFramePixels('dreamina-seedance-2-5-260628', 'adaptive', '1080p')).toBe(
      2206 * 946,
    );
  });

  it('a 15 s long model: that model over 15 s is impossible, so nothing for 20 s', () => {
    const { sd } = adapter([], { longModel: 'dreamina-seedance-2-0-260128' });
    expect(sd.modelFor(10)).toBe('dreamina-seedance-2-0-mini-260615');
    expect(sd.modelFor(20)).toBeUndefined();
  });

  it('480p when asked (20.25 BASIC): the documented 480p frame and its smaller bill', () => {
    const { sd } = adapter([]);
    const basic = { ...t2v, durationSec: 4, resolution: '480p' as const };
    expect(sd.buildBody(basic)).toMatchObject({ resolution: '480p', duration: 4 });
    // 2.0 mini 9:16 480p = 496 × 864: 4 × 496 × 864 × 24 / 1024 = 40,176 tokens → $0.1406 → 11p
    expect(sd.estimateCostPence(basic)).toBe(11);
    // 720p (the default) is 86,400 tokens → $0.3024 → 23p
    expect(sd.estimateCostPence({ ...basic, resolution: '720p' })).toBe(23);
    expect(sd.estimateCostPence({ ...t2v, durationSec: 4 })).toBe(23);
  });

  it('480p frames differ between the 2.0 series and 2.5 (create-task pixel table)', () => {
    expect(seedanceFramePixels('dreamina-seedance-2-0-mini-260615', '9:16', '480p')).toBe(
      496 * 864,
    );
    expect(seedanceFramePixels('dreamina-seedance-2-0-fast-260128', '16:9', '480p')).toBe(
      864 * 496,
    );
    expect(seedanceFramePixels('dreamina-seedance-2-5-260628', '9:16', '480p')).toBe(480 * 854);
    expect(seedanceFramePixels('dreamina-seedance-2-5-260628', '1:1', '480p')).toBe(640 * 640);
    expect(seedanceFramePixels('dreamina-seedance-2-0-mini-260615', '3:4', '480p')).toBe(560 * 752);
    expect(seedanceFramePixels('dreamina-seedance-2-0-mini-260615', 'adaptive', '480p')).toBe(
      992 * 432,
    );
    expect(seedanceFramePixels('dreamina-seedance-2-0-mini-260615', '9:16', '720p')).toBe(
      720 * 1280,
    );
    expect(seedanceFramePixels('dreamina-seedance-2-5-260628', 'adaptive', '720p')).toBe(
      834 * 1112,
    );
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

  it('21.3 reads SEEDANCE_FULL_MODEL (Mini puts every tier back on Mini)', () => {
    expect(
      seedanceOptionsFromEnv({ SEEDANCE_FULL_MODEL: ' dreamina-seedance-2-0-mini-260615 ' }),
    ).toEqual({ fullModel: 'dreamina-seedance-2-0-mini-260615' });
    expect(seedanceOptionsFromEnv({ SEEDANCE_FULL_MODEL: '' })).toEqual({});
  });

  it.each([
    ['SEEDANCE_MODEL', 'seedance-1-5-pro-251215'], // retired, no price row
    ['SEEDANCE_FULL_MODEL', 'dreamina-seedance-2-0-pro'],
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

  it('21.3 1080p list prices: 2.0 $7.7, 2.5 $11.7 per M tokens; mini and fast have none', () => {
    expect(seedanceUsdPerMillionTokens('dreamina-seedance-2-0-260128', '1080p')).toBe(7.7);
    expect(seedanceUsdPerMillionTokens('dreamina-seedance-2-0-260128', '720p')).toBe(7.0);
    expect(seedanceUsdPerMillionTokens('dreamina-seedance-2-0-260128', '480p')).toBe(7.0);
    expect(seedanceUsdPerMillionTokens('dreamina-seedance-2-5-260628', '1080p')).toBe(11.7);
    expect(seedanceUsdPerMillionTokens('dreamina-seedance-2-0-mini-260615', '1080p')).toBe(3.5);
    // Pricing-page example: 2.0, 1080p 16:9, 5 s = 243,000 tokens → $1.87 a video, $0.37 a second.
    const tokens = seedanceTokens(5, 1920 * 1080);
    expect(tokens).toBe(243_000);
    expect((tokens * 7.7) / 1e6).toBeCloseTo(1.87, 2);
  });

  it('21.3 cost per tier for a 4 s 9:16 clip at 0.75 (list prices)', () => {
    const { sd } = adapter([]);
    const shot = { ...t2v, durationSec: 4 };
    // BASIC: mini 480p 40,176 tokens × $3.5/M = $0.1406 → 10.55p → 11p
    expect(sd.estimateCostPence({ ...shot, planTier: 'BASIC', resolution: '480p' })).toBe(11);
    // STANDARD: 2.0 720p 86,400 tokens × $7.0/M = $0.6048 → 45.36p → 46p
    expect(sd.estimateCostPence({ ...shot, planTier: 'STANDARD', resolution: '720p' })).toBe(46);
    // PLUS / ENTERPRISE: 2.0 1080p 194,400 tokens × $7.7/M = $1.4969 → 112.27p → 113p
    for (const planTier of ['PLUS', 'ENTERPRISE'] as const) {
      expect(sd.estimateCostPence({ ...shot, planTier, resolution: '1080p' })).toBe(113);
    }
    // A 5 s PLUS clip: 243,000 tokens × $7.7/M = $1.8711 → 140.33p → 141p
    expect(sd.estimateCostPence({ ...t2v, planTier: 'PLUS', resolution: '1080p' })).toBe(141);
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

describe('21.3 Mini fallback when the full model is refused', () => {
  const plus = {
    ...t2v,
    durationSec: 4,
    planTier: 'PLUS' as const,
    resolution: '1080p' as const,
  };

  function withEvents(replies: Parameters<typeof fakeFetch>, nowRef = { now: NOW }) {
    const events: SeedanceFallbackEvent[] = [];
    const built = adapter(replies, {
      now: () => nowRef.now,
      onFullModelFallback: (e) => events.push(e),
    });
    return { ...built, events, nowRef };
  }

  it.each([
    ['not activated (ModelNotOpen)', arkError('ModelNotOpen', 'has not activated the model', 404)],
    ['service not open', arkError('OperationDenied.ServiceNotOpen', 'activate the model', 403)],
    ['out of credit (overdue)', arkError('AccountOverdueError', 'overdue balance', 403)],
    ['resource pack used up (wording)', arkError('SomethingNew', 'insufficient balance', 400)],
  ])('%s → the same shot on Mini at 720p, reported once', async (_name, refusal) => {
    const { sd, requests, events } = withEvents([refusal, json({ id: TASK })]);
    const submitted = await sd.submit(plus);
    expect(requests.map((r) => (r.body as { model: string }).model)).toEqual([
      'dreamina-seedance-2-0-260128',
      'dreamina-seedance-2-0-mini-260615',
    ]);
    expect(requests[0]?.body).toMatchObject({ resolution: '1080p' });
    expect(requests[1]?.body).toMatchObject({ resolution: '720p', duration: 4, ratio: '9:16' });
    // Mini 720p 4 s: 86,400 tokens × $3.5/M = $0.3024 → 23p (the estimate follows the model used)
    expect(submitted).toMatchObject({ providerJobId: TASK, estimatedCostPence: 23 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from: 'dreamina-seedance-2-0-260128',
      to: 'dreamina-seedance-2-0-mini-260615',
    });
    expect(['auth', 'insufficient_credits']).toContain(events[0]?.errorClass);
  });

  it('later shots go straight to Mini until the retry window passes, then try 2.0 again', async () => {
    const { sd, requests, nowRef } = withEvents([
      arkError('ModelNotOpen', 'not activated', 404),
      json({ id: TASK }),
      json({ id: TASK }),
      json({ id: TASK }),
    ]);
    await sd.submit(plus);
    expect(sd.fullModelSkipped()).toBe(true);
    expect(sd.modelFor(4, 'PLUS')).toBe('dreamina-seedance-2-0-mini-260615');
    // While skipped, the estimate (budget reservation) is Mini's.
    expect(sd.estimateCostPence(plus)).toBe(23);
    await sd.submit(plus);
    expect((requests[2]?.body as { model: string }).model).toBe(
      'dreamina-seedance-2-0-mini-260615',
    );
    nowRef.now = NOW + FULL_MODEL_RETRY_AFTER_MS;
    expect(sd.fullModelSkipped()).toBe(false);
    await sd.submit(plus);
    expect((requests[3]?.body as { model: string }).model).toBe('dreamina-seedance-2-0-260128');
  });

  it('Mini refused too → the error reaches the router (account hold, then Kling)', async () => {
    const { sd, requests } = withEvents([
      arkError('AccountOverdueError', 'overdue balance', 403),
      arkError('AccountOverdueError', 'overdue balance', 403),
    ]);
    await expect(sd.submit(plus)).rejects.toMatchObject({
      providerId: 'seedance',
      errorClass: 'insufficient_credits',
      retryable: false,
    });
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['rate limited', arkError('RequestBurstTooFast', 'slow down', 429), 'rate_limited'],
    ['moderation', arkError('InputTextSensitiveContentDetected', 'no', 400), 'content_policy'],
    ['bad input', arkError('InvalidParameter', 'bad ratio', 400), 'invalid_request'],
    ['provider down', arkError('InternalServiceError', 'oops', 500), 'provider_unavailable'],
  ])('%s does not fall back to Mini', async (_name, refusal, errorClass) => {
    const { sd, requests, events } = withEvents([refusal]);
    await expect(sd.submit(plus)).rejects.toMatchObject({ errorClass });
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(0);
    expect(sd.fullModelSkipped()).toBe(false);
  });

  it('BASIC (already Mini) and long shots on 2.5 never fall back', async () => {
    const basic = withEvents([arkError('ModelNotOpen', 'not activated', 404)]);
    await expect(basic.sd.submit({ ...plus, planTier: 'BASIC' })).rejects.toMatchObject({
      errorClass: 'auth',
    });
    expect(basic.requests).toHaveLength(1);
    const long = withEvents([arkError('ModelNotOpen', 'not activated', 404)]);
    await expect(long.sd.submit({ ...plus, durationSec: 20 })).rejects.toMatchObject({
      errorClass: 'auth',
    });
    expect(long.requests).toHaveLength(1);
    expect([...basic.events, ...long.events]).toHaveLength(0);
  });

  it('no fallback when SEEDANCE_FULL_MODEL is Mini itself', async () => {
    const { sd: mini, requests } = adapter([arkError('ModelNotOpen', 'not activated', 404)], {
      fullModel: 'dreamina-seedance-2-0-mini-260615',
    });
    await expect(mini.submit(plus)).rejects.toMatchObject({ errorClass: 'auth' });
    expect(requests).toHaveLength(1);
    expect(mini.fullModelSkipped()).toBe(false);
  });
});

describe('SeedanceAdapter.poll', () => {
  it('21.3 a 1080p task is costed at the 1080p rate', async () => {
    const { sd } = adapter([
      json(
        task('succeeded', {
          model: 'dreamina-seedance-2-0-260128',
          content: { video_url: VIDEO_URL },
          usage: { completion_tokens: 194_400 },
          resolution: '1080p',
        }),
      ),
    ]);
    const done = await sd.poll(TASK);
    // 194,400 tokens × $7.7/M = $1.4969 → 112.27p → 113p (720p rate would give 103p)
    expect(done.output?.metadata).toMatchObject({ costPence: 113, resolution: '1080p' });
  });

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
