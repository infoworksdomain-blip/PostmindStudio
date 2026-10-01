import { describe, expect, it } from 'vitest';
import { parseFailure } from './failure-reasons';

// BACKLOG 17.9 — stored failure reasons → stable code + params + untranslated detail.

describe('parseFailure', () => {
  it('returns null for empty reasons and for reasons without a known code', () => {
    expect(parseFailure(null)).toBeNull();
    expect(parseFailure('   ')).toBeNull();
    expect(parseFailure('Something odd happened')).toBeNull();
    expect(parseFailure('mystery_code: details')).toBeNull();
  });

  it('reads bare codes and codes with server-worded English (dropped)', () => {
    expect(parseFailure('cancelled_by_user')).toMatchObject({
      code: 'cancelled_by_user',
      detail: null,
    });
    expect(parseFailure('restricted_topics: user confirmation required (spec 13.3)')).toMatchObject(
      { code: 'restricted_topics', detail: null },
    );
    expect(
      parseFailure('cost_cap_paused: organisation daily cost cap reached (£5.00 of £5.00 today)'),
    ).toMatchObject({ code: 'cost_cap_paused', detail: null });
  });

  it('keeps text the server did not write as the detail', () => {
    expect(parseFailure('script_safety_block: Mentions a named competitor')).toMatchObject({
      code: 'script_safety_block',
      detail: 'Mentions a named competitor',
    });
    expect(parseFailure('rejected: Logo is wrong')).toMatchObject({
      code: 'rejected',
      detail: 'Logo is wrong',
    });
    expect(parseFailure('content_safety_blocked_by_review: not for kids')).toMatchObject({
      code: 'content_safety_blocked_by_review',
      detail: 'not for kids',
    });
  });

  it('reads kill-switch levels wherever they appear as the reason', () => {
    expect(parseFailure('kill_switch_workspace: Studio kill switch active (workspace)')).toEqual({
      code: 'kill_switch',
      params: { level: 'workspace' },
      detail: null,
      cause: null,
      rawCause: null,
    });
    expect(parseFailure('kill_switch_still_engaged: platform')?.params.level).toBe('platform');
  });

  it('parses wrapped causes (planning, composition, quality gate, scheduling)', () => {
    const planning = parseFailure('planning_failed: kill_switch_global: Studio kill switch active');
    expect(planning).toMatchObject({ code: 'planning_failed', cause: { code: 'kill_switch' } });
    const provider = parseFailure('composition_failed: shotstack/rate_limited: slow down');
    expect(provider?.cause).toMatchObject({
      code: 'provider_failure',
      params: { source: 'shotstack', errorClass: 'rate_limited' },
      detail: 'slow down',
    });
    const raw = parseFailure('quality_gate_error: ffprobe exited with 1');
    expect(raw).toMatchObject({ cause: null, rawCause: 'ffprobe exited with 1' });
    expect(parseFailure('scheduling failed: kill_switch_platform: x')).toMatchObject({
      code: 'scheduling_failed',
      cause: { code: 'kill_switch', params: { level: 'platform' } },
    });
  });

  it('extracts shot numbers and failed checks', () => {
    expect(
      parseFailure(
        'asset_generation_failed: shot 1: runway/timeout: slow; shot 3: luma/unknown: boom',
      )?.params.shots,
    ).toEqual([1, 3]);
    expect(
      parseFailure(
        'content_safety_block: tiktok/content_safety [BLOCK]: Blocked: general_nsfw=0.91; youtube_short/audio_present: no audio stream',
      )?.params.checks,
    ).toEqual([
      { platform: 'tiktok', check: 'content_safety' },
      { platform: 'youtube_short', check: 'audio_present' },
    ]);
  });

  it('20.11: reads service_unavailable and older provider account failures as it', () => {
    expect(
      parseFailure('service_unavailable: Every text_generation provider is unavailable'),
    ).toMatchObject({
      code: 'service_unavailable',
      detail: null,
    });
    for (const cls of ['auth', 'insufficient_credits', 'account_limit']) {
      expect(parseFailure(`anthropic/${cls}: {"type":"error"}`)).toMatchObject({
        code: 'service_unavailable',
        detail: null,
      });
    }
    expect(parseFailure('planning_failed: service_unavailable: x')?.cause?.code).toBe(
      'service_unavailable',
    );
  });

  it('reads provider and platform failures with their error class', () => {
    expect(parseFailure('tiktok/needs_reconnect: token revoked')).toMatchObject({
      code: 'provider_failure',
      params: { source: 'tiktok', errorClass: 'needs_reconnect' },
      detail: 'token revoked',
    });
  });

  it('maps the coded scan and publication reasons, and the sentences older rows stored', () => {
    expect(parseFailure('robots_blocked: The site…')?.code).toBe('robots_blocked');
    expect(parseFailure('scan_cost_cap: Stopped at the scan cost cap (50p)')).toMatchObject({
      code: 'scan_cost_cap',
      params: { pence: 50 },
      detail: null,
    });
    expect(
      parseFailure(
        'scan_images_capped: Stopped at the scan cost cap (50p): some images were not indexed for search',
      ),
    ).toMatchObject({ code: 'scan_images_capped', params: { pence: 50 } });
    // Legacy rows (before 17.9).
    expect(
      parseFailure("The site's robots.txt does not allow PostMindStudio to fetch the homepage")
        ?.code,
    ).toBe('robots_blocked');
    expect(parseFailure('No pages could be fetched')?.code).toBe('no_pages');
    expect(parseFailure('Stopped: website ownership was disputed')?.code).toBe(
      'ownership_disputed',
    );
    expect(parseFailure('YouTube upload quota reached; retrying after the daily reset')?.code).toBe(
      'youtube_quota_deferred',
    );
    expect(
      parseFailure('Stopped at the scan cost cap (40p): some images were not indexed for search'),
    ).toMatchObject({ code: 'scan_images_capped', params: { pence: 40 } });
  });
});
