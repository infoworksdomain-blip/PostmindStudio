import { describe, expect, it } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import {
  approvalOrigin,
  buildTargets,
  connectionsFor,
  readAutoPublishResult,
  readReview,
  readScheduleIssue,
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

  it('offers org-wide Meta channels (businessId null) registered by PostMind', () => {
    const list = [
      conn({ id: 'ig', platform: 'instagram', businessId: null }),
      conn({ id: 'fb-other', platform: 'facebook', businessId: 'other' }),
    ];
    expect(connectionsFor('instagram_reel', list, 'biz').map((c) => c.id)).toEqual(['ig']);
    expect(connectionsFor('facebook', list, 'biz')).toEqual([]);
  });

  it('builds targets only for chosen accounts', () => {
    expect(buildTargets(['tiktok', 'x', 'facebook'], { tiktok: 'a', facebook: 'f' })).toEqual([
      { platform: 'tiktok', connectionId: 'a' },
      { platform: 'facebook', connectionId: 'f' },
    ]);
    expect(templatePlatforms(undefined)).toEqual([]);
  });
});

describe('readScheduleIssue (20.3)', () => {
  it('returns a known reason with defaults, else null', () => {
    expect(readScheduleIssue({ scheduleIssue: { reason: 'no_matching_platform' } })).toEqual({
      reason: 'no_matching_platform',
      horizonDays: 56,
      at: '',
    });
    expect(
      readScheduleIssue({ scheduleIssue: { reason: 'queue_off', horizonDays: 28, at: 't' } }),
    ).toEqual({ reason: 'queue_off', horizonDays: 28, at: 't' });
    expect(readScheduleIssue({ scheduleIssue: { reason: 'other' } })).toBeNull();
    expect(readScheduleIssue(null)).toBeNull();
  });
});
