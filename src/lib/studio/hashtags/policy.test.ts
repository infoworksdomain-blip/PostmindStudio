import { describe, expect, it } from 'vitest';
import { composeCaption, fitCaption } from '../platforms/captions';
import { PLATFORMS } from '../services/catalog';
import { fitSuggestion } from '../services/caption-suggestions';
import { assembleHashtags, hashtagLimits, MIN_HASHTAGS, safeHashtags } from './policy';

const policy = { business: 'AheadAI', always: ['LeedsEats', 'aheadai'] };

describe('assembleHashtags (20.13)', () => {
  it('puts the business hashtag first, then always, then chosen, de-duplicated', () => {
    const result = assembleHashtags('instagram_reel', {
      policy,
      chosen: ['bread', 'LEEDSEATS', 'sourdough', 'Bread'],
    });
    expect(result.hashtags).toEqual(['AheadAI', 'LeedsEats', 'bread', 'sourdough']);
    expect(result.locked).toEqual(['AheadAI', 'LeedsEats']);
    expect(result.short).toBe(true);
  });

  it('tops up to the minimum from the pool and records what it added', () => {
    const result = assembleHashtags('tiktok', {
      policy,
      chosen: ['bread'],
      pool: ['bread', 'Leeds', 'bad tag', 'BakeryLife', 'x'.repeat(40), 'Sourdough'],
    });
    expect(result.hashtags).toEqual(['AheadAI', 'LeedsEats', 'bread', 'Leeds', 'BakeryLife']);
    expect(result.toppedUp).toEqual(['Leeds', 'BakeryLife']);
    expect(result.short).toBe(false);
  });

  it('never exceeds the platform maximum; the business hashtag is never dropped', () => {
    const always = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const result = assembleHashtags('tiktok', {
      policy: { business: 'AheadAI', always },
      chosen: ['bread'],
    });
    expect(result.hashtags).toEqual(['AheadAI', 'a1', 'a2', 'a3', 'a4']);
    expect(result.dropped).toEqual(['a5', 'a6', 'bread']);
  });

  it('leaves #Shorts to composeCaption and does not count it', () => {
    const result = assembleHashtags('youtube_short', {
      policy,
      chosen: ['Shorts', 'bread', 'cake', 'leeds'],
    });
    expect(result.hashtags).not.toContain('Shorts');
    expect(result.hashtags).toHaveLength(5);
  });

  it('every platform allows the minimum', () => {
    for (const p of PLATFORMS) {
      expect(hashtagLimits(p).min).toBe(MIN_HASHTAGS);
      expect(hashtagLimits(p).max).toBeGreaterThanOrEqual(MIN_HASHTAGS);
    }
    expect(hashtagLimits('instagram_reel').max).toBe(30);
    expect(hashtagLimits('x').max).toBe(5);
  });

  it('safeHashtags drops invalid tags and over-long suggestions', () => {
    expect(safeHashtags(['#ok', 'two words', 3, 'x'.repeat(31)], 30)).toEqual(['ok']);
  });
});

describe('X fitting (280 characters including 5 hashtags)', () => {
  it('shortens a long caption so 5 hashtags fit, prefers short top-up tags', () => {
    const fitted = fitSuggestion(
      'x',
      {
        platform: 'x',
        caption: 'Fresh sourdough every morning in Leeds. '.repeat(10),
        hashtags: [],
      },
      {
        policy: { business: 'AheadAI', always: [] },
        pool: ['SourdoughBreadLovers', 'Leeds', 'Bread', 'BakeryLifeUK', 'Bake'],
      },
    );
    expect(fitted.hashtags).toHaveLength(5);
    expect(fitted.hashtags[0]).toBe('AheadAI');
    expect(fitted.hashtags).toEqual(['AheadAI', 'Bake', 'Leeds', 'Bread', 'BakeryLifeUK']);
    expect(fitted.captionTruncated).toBe(true);
    const composed = composeCaption('x', { caption: fitted.caption, hashtags: fitted.hashtags });
    expect([...composed.text].length).toBeLessThanOrEqual(280);
  });

  it('five maximum-length (30-character) hashtags still leave room for a caption', () => {
    const tags = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(30));
    const fitted = fitCaption('x', { caption: 'word '.repeat(80), hashtags: tags });
    expect([...fitted.caption].length).toBeGreaterThan(100);
    expect(() => composeCaption('x', { caption: fitted.caption, hashtags: tags })).not.toThrow();
  });
});
