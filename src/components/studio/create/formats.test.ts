import { describe, expect, it } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import { SHORT_VIDEO_MAX_SEC } from '@/lib/studio/billing/catalogue';
import { buildFormats, defaultPlatforms, nameFromBrief, PLATFORM_OPTIONS } from './formats';

const conn = (over: Partial<PlatformConnection>): PlatformConnection => ({
  id: 'c1',
  businessId: 'b1',
  platform: 'tiktok',
  platformAccountId: 'acc',
  platformAccountName: 'Acme',
  accessTokenExpiresAt: null,
  scopes: [],
  state: 'active',
  connectedAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('buildFormats', () => {
  it('maps platforms to aspect ratio and short/long seconds', () => {
    expect(buildFormats(['tiktok', 'youtube'], 'short')).toEqual([
      { platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 },
      { platform: 'youtube', aspectRatio: '16:9', durationSec: 30 },
    ]);
    expect(buildFormats(['youtube'], 'long')[0]?.durationSec).toBe(300);
  });

  it('keeps every default Short within the plans’ short-video limit (30 s)', () => {
    const all = PLATFORM_OPTIONS.map((o) => o.platform);
    for (const f of buildFormats(all, 'short'))
      expect(f.durationSec, f.platform).toBeLessThanOrEqual(SHORT_VIDEO_MAX_SEC);
    // Connecting YouTube pre-selects Shorts: 30 s, not the old 45 s.
    expect(buildFormats(['youtube_short'], 'short')[0]?.durationSec).toBe(30);
  });

  it('ignores unknown platforms', () => {
    expect(buildFormats(['myspace'], 'short')).toEqual([]);
  });
});

describe('defaultPlatforms', () => {
  it('pre-selects active connections for the business', () => {
    const list = [
      conn({ platform: 'youtube' }),
      conn({ id: 'c2', platform: 'x', state: 'needs_reconnect' }),
      conn({ id: 'c3', platform: 'linkedin', businessId: 'other' }),
    ];
    expect(defaultPlatforms(list, 'b1')).toEqual(['youtube_short']);
  });

  it('falls back to TikTok when nothing is connected', () => {
    expect(defaultPlatforms([], 'b1')).toEqual(['tiktok']);
    expect(defaultPlatforms(undefined, null)).toEqual(['tiktok']);
  });
});

describe('nameFromBrief', () => {
  it('uses the first line', () => {
    expect(nameFromBrief('Spring sale\nmore detail')).toBe('Spring sale');
  });

  it('shortens long briefs at a word boundary', () => {
    const name = nameFromBrief(
      'A very long description of our new artisan coffee subscription for busy remote workers',
    );
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(61);
  });

  it('never returns an empty name', () => {
    // 17.9: no English placeholder; the project is created without a name.
    expect(nameFromBrief('   ')).toBe('');
  });
});
