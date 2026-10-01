import { describe, expect, it } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import {
  approvalOrigin,
  buildTargets,
  connectionsFor,
  hasConnectedAccount,
  publishablePlatforms,
  readAutoPublishResult,
  readReview,
  readScheduleIssue,
  readTargets,
  resolveAccounts,
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

describe('20.12 accounts for the chosen platforms', () => {
  const tiktok = conn({ id: 'tt' });
  const yt1 = conn({ id: 'yt1', platform: 'youtube' });
  const yt2 = conn({ id: 'yt2', platform: 'youtube' });
  const other = conn({ id: 'x-other', platform: 'x', businessId: 'biz-2' });
  const stale = conn({ id: 'li', platform: 'linkedin', state: 'needs_reconnect' });

  it('knows whether the business has any account, and which platforms it can post', () => {
    expect(hasConnectedAccount([], 'biz')).toBe(false);
    expect(hasConnectedAccount([other, stale], 'biz')).toBe(false);
    expect(hasConnectedAccount([tiktok], 'biz')).toBe(true);
    expect(
      publishablePlatforms(
        ['tiktok', 'youtube_short', 'x', 'linkedin_video'],
        [tiktok, yt1, other, stale],
        'biz',
      ),
    ).toEqual(['tiktok', 'youtube_short']);
  });

  it('pre-selects the only account, keeps a valid choice and drops stale ones', () => {
    const all = [tiktok, yt1, yt2, other];
    // TikTok has one account (pre-selected); YouTube has two (the owner picks).
    expect(resolveAccounts(['tiktok', 'youtube_short'], {}, all, 'biz')).toEqual({ tiktok: 'tt' });
    expect(resolveAccounts(['youtube_short'], { youtube_short: 'yt2' }, all, 'biz')).toEqual({
      youtube_short: 'yt2',
    });
    // '' = "don't auto-publish" wins over the pre-selection.
    expect(resolveAccounts(['tiktok'], { tiktok: '' }, all, 'biz')).toEqual({});
    // A choice from another business (or a disconnected account) is not kept.
    expect(resolveAccounts(['x'], { x: 'x-other' }, all, 'biz')).toEqual({});
    expect(resolveAccounts(['tiktok'], { tiktok: 'gone' }, all, 'biz')).toEqual({ tiktok: 'tt' });
  });
});
