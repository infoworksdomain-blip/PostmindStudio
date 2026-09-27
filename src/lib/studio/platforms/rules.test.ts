import { describe, expect, it } from 'vitest';
import { checkFormat, PLATFORM_RULES } from './rules';

describe('PLATFORM_RULES', () => {
  it('routes Meta platforms through Engagement credentials and Studio platforms through OAuth', () => {
    expect(PLATFORM_RULES.instagram_reel.credentials).toBe('meta');
    expect(PLATFORM_RULES.facebook.credentials).toBe('meta');
    expect(PLATFORM_RULES.tiktok.credentials).toBe('studio');
    expect(PLATFORM_RULES.youtube.credentials).toBe('studio');
    expect(PLATFORM_RULES.youtube_short.credentials).toBe('studio');
    expect(PLATFORM_RULES.linkedin_video.credentials).toBe('studio');
    expect(PLATFORM_RULES.x.credentials).toBe('studio');
  });
});

describe('checkFormat', () => {
  it('returns no problems for a render matching every rule', () => {
    expect(
      checkFormat('tiktok', { aspectRatio: '9:16', durationSec: 30, sizeBytes: 1024 }),
    ).toEqual([]);
  });

  it('flags an unsupported aspect ratio', () => {
    const problems = checkFormat('tiktok', { aspectRatio: '16:9', durationSec: 30 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('9:16');
  });

  it('flags a duration below the minimum', () => {
    const problems = checkFormat('instagram_reel', { aspectRatio: '9:16', durationSec: 1 });
    expect(problems.some((p) => p.includes('3'))).toBe(true);
  });

  it('flags a duration above the maximum', () => {
    const problems = checkFormat('facebook', { aspectRatio: '9:16', durationSec: 91 });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('flags a file over the platform size limit when sizeBytes is provided', () => {
    const problems = checkFormat('x', {
      aspectRatio: '16:9',
      durationSec: 10,
      sizeBytes: 9 * 1024 ** 3,
    });
    expect(problems.some((p) => p.includes('MB'))).toBe(true);
  });

  it('skips the size check when sizeBytes is not provided', () => {
    const problems = checkFormat('x', { aspectRatio: '16:9', durationSec: 10 });
    expect(problems).toEqual([]);
  });

  it('accumulates multiple problems at once', () => {
    const problems = checkFormat('tiktok', {
      aspectRatio: '1:1',
      durationSec: 700,
      sizeBytes: 5 * 1024 ** 3,
    });
    expect(problems).toHaveLength(3);
  });

  it('accepts boundary duration values at the min and max', () => {
    expect(checkFormat('x', { aspectRatio: '16:9', durationSec: 1 })).toEqual([]);
    expect(checkFormat('x', { aspectRatio: '16:9', durationSec: 140 })).toEqual([]);
  });
});
