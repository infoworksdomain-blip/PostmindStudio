import { describe, expect, it } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import {
  approvalOrigin,
  buildTargets,
  connectionsFor,
  readAutoPublishResult,
  readReview,
  readTargets,
  templatePlatforms,
} from './automation';

const conn = (over: Partial<PlatformConnection>): PlatformConnection => ({
  id: 'c1',
  businessId: 'biz',
  platform: 'tiktok',
  platformAccountId: 'acct',
  platformAccountName: 'Acme',
  accessTokenExpiresAt: null,
  scopes: [],
  state: 'active',
  connectedAt: '2026-09-27T00:00:00Z',
  ...over,
});

describe('automation helpers', () => {
  it('reads review, targets and results defensively', () => {
    expect(readReview({ review: { decision: 'needs_review', at: 'x' } })).toMatchObject({
      decision: 'needs_review',
    });
    expect(readReview({ review: { decision: 'maybe' } })).toBeNull();
    expect(readReview(null)).toBeNull();
    expect(readTargets({ autoPublish: { targets: [{ platform: 'x' }, 'junk', {}] } })).toEqual([
      { platform: 'x' },
    ]);
    expect(readTargets({ autoPublish: 'nope' })).toEqual([]);
    expect(readAutoPublishResult({ autoPublishResult: { results: [] } })).toEqual({ results: [] });
    expect(readAutoPublishResult({ autoPublishResult: { results: 'x' } })).toBeNull();
  });

  it('tells automatic approvals from human ones', () => {
    expect(approvalOrigin([])).toBeNull();
    expect(approvalOrigin([{ state: 'REJECTED', resolvedByUserId: 'u' }])).toBeNull();
    expect(approvalOrigin([{ state: 'APPROVED', resolvedByUserId: 'system:auto-approve' }])).toBe(
      'automatic',
    );
    expect(approvalOrigin([{ state: 'APPROVED', resolvedByUserId: 'u' }])).toBe('person');
  });

  it('offers only active connections of the business for platforms Studio publishes', () => {
    const list = [
      conn({ id: 'a' }),
      conn({ id: 'b', state: 'needs_reconnect' }),
      conn({ id: 'c', businessId: 'other' }),
      conn({ id: 'd', platform: 'youtube' }),
    ];
    expect(connectionsFor('tiktok', list, 'biz').map((c) => c.id)).toEqual(['a']);
    expect(connectionsFor('youtube_short', list, 'biz').map((c) => c.id)).toEqual(['d']);
    expect(connectionsFor('instagram_reel', list, 'biz')).toEqual([]);
  });

  it('builds targets only for chosen accounts on supported platforms', () => {
    expect(buildTargets(['tiktok', 'x', 'facebook'], { tiktok: 'a', facebook: 'f' })).toEqual([
      { platform: 'tiktok', connectionId: 'a' },
    ]);
    expect(templatePlatforms(undefined)).toEqual([]);
  });
});
