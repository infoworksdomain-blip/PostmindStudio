import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { classifyHeyGenCode, HeyGenAdapter } from './heygen';

// Fixtures follow developers.heygen.com (POST /v3/videos, GET /v3/videos/{id},
// GET /v3/users/me, error-code catalogue) and its OpenAPI schemas.
const NOW = Date.parse('2026-09-27T12:00:00Z');
const VIDEO_ID = '4086e92fc7a54d67b62ef93b1ccf53db';

function adapter(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    heygen: new HeyGenAdapter({
      apiKey: 'hg-key',
      defaultAvatarId: 'stock-avatar-look',
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

const avatar = {
  capability: 'avatar_video' as const,
  organisationId: 'org-1',
  shotId: 'shot-1',
  audioUrl: 'https://assets.example/voice.mp3?X-Amz-Signature=abc',
  durationSec: 6.2,
  aspectRatio: '9:16' as const,
};

const created = { data: { video_id: VIDEO_ID, status: 'waiting', output_format: 'mp4' } };

const detail = (patch: Record<string, unknown>) => ({
  data: {
    id: VIDEO_ID,
    title: 'PostMind Studio shot shot-1',
    status: 'processing',
    created_at: 1_790_000_000,
    video_url: null,
    thumbnail_url: null,
    duration: null,
    failure_code: null,
    failure_message: null,
    ...patch,
  },
});

describe('HeyGenAdapter.submit', () => {
  it('posts a v3 avatar video lip-synced to the narration audio', async () => {
    const { heygen, requests } = adapter(json(created));
    const submitted = await heygen.submit(avatar);
    expect(requests[0]).toMatchObject({
      url: 'https://api.heygen.com/v3/videos',
      method: 'POST',
      headers: { 'x-api-key': 'hg-key' },
      body: {
        type: 'avatar',
        avatar_id: 'stock-avatar-look',
        audio_url: avatar.audioUrl,
        aspect_ratio: '9:16',
        resolution: '1080p',
        output_format: 'mp4',
        title: 'PostMind Studio shot shot-1',
      },
    });
    // 7s (rounded up) * $0.05 * 0.75 = 26.25p → 27p
    expect(submitted).toEqual({
      providerJobId: VIDEO_ID,
      estimatedCostPence: 27,
      estimatedReadyAt: new Date(NOW + 300_000),
    });
  });

  it('uses a requested avatar id and passes 4:5 through', async () => {
    const { heygen, requests } = adapter(json(created));
    await heygen.submit({ ...avatar, avatarId: 'brand-twin', aspectRatio: '4:5' });
    expect(requests[0]?.body).toMatchObject({ avatar_id: 'brand-twin', aspect_ratio: '4:5' });
  });

  it.each([
    [{ durationSec: 0 }, 'renders up to'],
    [{ durationSec: 1801 }, 'renders up to'],
    [{ audioUrl: 'http://localhost:9000/voice.mp3' }, 'public HTTPS audio_url'],
  ])('rejects invalid input %o without calling HeyGen', async (patch, message) => {
    const { heygen, requests } = adapter();
    await expect(heygen.submit({ ...avatar, ...patch })).rejects.toMatchObject({
      errorClass: 'invalid_request',
      message: expect.stringContaining(message),
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects capabilities it does not have', async () => {
    const { heygen } = adapter();
    await expect(
      heygen.submit({
        capability: 'text_to_video',
        organisationId: 'o',
        prompt: 'p',
        durationSec: 5,
        aspectRatio: '9:16',
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });

  it.each([
    [400, 'invalid_parameter', 'invalid_request', false],
    [400, 'content_policy_violation', 'content_policy', false],
    [400, 'avatar_not_usable', 'content_policy', false],
    [400, 'download_failed', 'invalid_request', false],
    [401, 'unauthorized', 'auth', false],
    [402, 'insufficient_credit', 'insufficient_credits', false],
    [402, 'plan_upgrade_required', 'insufficient_credits', false],
    [404, 'avatar_not_found', 'invalid_request', false],
    [409, 'request_in_progress', 'provider_unavailable', true],
    [429, 'rate_limit_exceeded', 'rate_limited', true],
    [429, 'quota_exceeded', 'insufficient_credits', false],
    [500, 'internal_error', 'provider_unavailable', true],
  ])('maps HTTP %i %s to %s', async (status, code, errorClass, retryable) => {
    const { heygen } = adapter(json({ error: { code, message: 'details' } }, status));
    await expect(heygen.submit(avatar)).rejects.toMatchObject({
      errorClass,
      retryable,
      message: `${code}: details`,
    });
  });

  it('maps network failures to retryable provider_unavailable', async () => {
    const { heygen } = adapter(new TypeError('fetch failed'));
    await expect(heygen.submit(avatar)).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      retryable: true,
    });
  });
});

describe('HeyGenAdapter.poll', () => {
  it.each(['waiting', 'pending', 'processing'])('treats %s as running', async (status) => {
    const { heygen, requests } = adapter(json(detail({ status })));
    await expect(heygen.poll(VIDEO_ID)).resolves.toEqual({ state: 'running' });
    expect(requests[0]?.url).toBe(`https://api.heygen.com/v3/videos/${VIDEO_ID}`);
  });

  it('returns the video URL and the actual cost from the rendered duration', async () => {
    const { heygen } = adapter(
      json(
        detail({
          status: 'completed',
          video_url: 'https://files.heygen.ai/video.mp4?Expires=1',
          thumbnail_url: 'https://files.heygen.ai/thumb.jpg',
          duration: 6.04,
        }),
      ),
    );
    await expect(heygen.poll(VIDEO_ID)).resolves.toEqual({
      state: 'succeeded',
      output: {
        url: 'https://files.heygen.ai/video.mp4?Expires=1',
        metadata: {
          videoId: VIDEO_ID,
          resolution: '1080p',
          thumbnailUrl: 'https://files.heygen.ai/thumb.jpg',
          durationSec: 6.04,
          costPence: 27, // 7s * $0.05 * 0.75 → 27p
        },
      },
    });
  });

  it('keeps the submit estimate when no duration is reported', async () => {
    const { heygen } = adapter(
      json(detail({ status: 'completed', video_url: 'https://files.heygen.ai/v.mp4' })),
    );
    const polled = await heygen.poll(VIDEO_ID);
    expect(polled.output?.metadata).not.toHaveProperty('costPence');
  });

  it('classifies failures by failure_code', async () => {
    const { heygen } = adapter(
      json(
        detail({
          status: 'failed',
          failure_code: 'download_failed',
          failure_message: 'Failed to download a required asset',
        }),
      ),
    );
    await expect(heygen.poll(VIDEO_ID)).resolves.toEqual({
      state: 'failed',
      error: {
        class: 'invalid_request',
        retryable: false,
        message: 'download_failed: Failed to download a required asset',
      },
    });
  });

  it('reports a completed video without a URL, and a missing video, as retryable', async () => {
    const empty = adapter(json(detail({ status: 'completed' })));
    await expect(empty.heygen.poll(VIDEO_ID)).resolves.toMatchObject({
      state: 'failed',
      error: { retryable: true },
    });
    const gone = adapter(json({ error: { code: 'video_not_found', message: 'x' } }, 404));
    await expect(gone.heygen.poll(VIDEO_ID)).resolves.toMatchObject({
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('propagates other poll errors', async () => {
    const { heygen } = adapter(json({ error: { code: 'internal_error', message: 'x' } }, 500));
    await expect(heygen.poll(VIDEO_ID)).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
    });
  });
});

describe('classifyHeyGenCode', () => {
  it.each([
    [null, 'provider_unavailable', true],
    ['internal_error', 'provider_unavailable', true],
    ['voice_provider_error', 'provider_unavailable', true],
    ['gateway_timeout', 'provider_unavailable', true],
    ['rate_limit_exceeded', 'rate_limited', true],
    ['content_policy_violation', 'content_policy', false],
    ['insufficient_credit', 'insufficient_credits', false],
    ['script_too_short', 'invalid_request', false],
    ['avatar_consent_required', 'invalid_request', false],
    ['brand_new_code', 'unknown', false],
  ])('%s → %s', (code, errorClass, retryable) => {
    expect(classifyHeyGenCode(code)).toEqual({ class: errorClass, retryable });
  });
});

describe('HeyGenAdapter.cancel, healthCheck and estimate', () => {
  it('is honest that HeyGen documents no render cancel and sends nothing', async () => {
    const { heygen, requests } = adapter();
    await expect(heygen.cancel(VIDEO_ID)).rejects.toBeInstanceOf(NotImplementedError);
    expect(requests).toHaveLength(0);
  });

  it('checks the wallet balance and spending cap via /v3/users/me', async () => {
    const user = { username: 'u', email: null, first_name: null, last_name: null };
    const ok = adapter(
      json({
        data: {
          ...user,
          billing_type: 'wallet',
          wallet: { currency: 'usd', remaining_balance: 12.5 },
        },
      }),
    );
    expect(await ok.heygen.healthCheck()).toEqual({ healthy: true });
    expect(ok.requests[0]?.url).toBe('https://api.heygen.com/v3/users/me');

    const empty = adapter(
      json({
        data: {
          ...user,
          billing_type: 'wallet',
          wallet: { currency: 'usd', remaining_balance: 0 },
        },
      }),
    );
    expect((await empty.heygen.healthCheck()).reason).toContain('insufficient_credits');

    const capped = adapter(
      json({
        data: {
          ...user,
          billing_type: 'usage_based',
          usage_based: { spending_current_usd: 100, spending_cap_usd: 100 },
        },
      }),
    );
    expect((await capped.heygen.healthCheck()).reason).toContain('spending cap');

    const bad = adapter(json({ error: { code: 'unauthorized', message: 'Invalid key' } }, 401));
    expect((await bad.heygen.healthCheck()).reason).toBe('auth: unauthorized: Invalid key');
  });

  it('estimates per started second and 0 for other capabilities', () => {
    const { heygen } = adapter();
    expect(heygen.estimateCostPence({ ...avatar, durationSec: 10 })).toBe(38); // 37.5p → 38p
    expect(
      heygen.estimateCostPence({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).toBe(0);
  });
});
