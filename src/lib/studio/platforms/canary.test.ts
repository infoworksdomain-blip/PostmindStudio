import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { canaryCredentials, runPlatformCanary, type CanaryPlatform } from './canary';

describe('canaryCredentials', () => {
  it('reads each platform from its secrets and skips incomplete ones', () => {
    expect(canaryCredentials('youtube', { CANARY_YOUTUBE_ACCESS_TOKEN: ' t ' })).toEqual({
      accessToken: 't',
    });
    expect(canaryCredentials('youtube', {})).toBeNull();
    expect(canaryCredentials('instagram', { CANARY_INSTAGRAM_ACCESS_TOKEN: 't' })).toBeNull();
    expect(
      canaryCredentials('instagram', {
        CANARY_INSTAGRAM_ACCESS_TOKEN: 't',
        CANARY_INSTAGRAM_USER_ID: '1784',
      }),
    ).toEqual({ accessToken: 't', objectId: '1784' });
  });
});

describe('runPlatformCanary', () => {
  const cases: Array<[CanaryPlatform, Response, string, string]> = [
    [
      'youtube',
      json({ items: [{ id: 'UC1' }] }),
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      'channel UC1',
    ],
    [
      'tiktok',
      json({ data: { creator_username: 'bakery' }, error: { code: 'ok' } }),
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      'creator bakery',
    ],
    ['x', json({ data: { id: '42' } }), 'https://api.x.com/2/users/me', 'user 42'],
    ['linkedin', json({ sub: 'abc' }), 'https://api.linkedin.com/v2/userinfo', 'member resolved'],
    [
      'instagram',
      json({ data: [{ quota_usage: 1 }] }),
      'https://graph.facebook.com/v26.0/1784/content_publishing_limit?fields=quota_usage',
      'publishing limit read',
    ],
    [
      'facebook',
      json({ status: { video_status: 'ready' }, id: '9' }),
      'https://graph.facebook.com/v26.0/1784?fields=status',
      'video status read',
    ],
  ];

  it.each(cases)(
    '%s: calls the read-only endpoint with the token',
    async (platform, reply, url, detail) => {
      const fake = fakeFetch(reply);
      const result = await runPlatformCanary(
        platform,
        { accessToken: 'tok', objectId: '1784' },
        fake.fetch,
        'v26.0',
      );
      expect(result).toEqual({ platform, ok: true, detail });
      expect(fake.requests[0]?.url).toBe(url);
      expect(fake.requests[0]?.headers.authorization).toBe('Bearer tok');
    },
  );

  it.each(['youtube', 'tiktok', 'x', 'linkedin', 'instagram', 'facebook'] as CanaryPlatform[])(
    '%s: fails when the documented field is missing',
    async (platform) => {
      const fake = fakeFetch(json({}));
      await expect(
        runPlatformCanary(platform, { accessToken: 'tok', objectId: '1' }, fake.fetch),
      ).rejects.toMatchObject({ platform, message: expect.stringContaining('Canary') });
    },
  );

  it('fails when the platform rejects the token', async () => {
    const fake = fakeFetch(json({ error: { message: 'expired' } }, 401));
    await expect(runPlatformCanary('x', { accessToken: 'tok' }, fake.fetch)).rejects.toMatchObject({
      platform: 'x',
    });
  });
});
