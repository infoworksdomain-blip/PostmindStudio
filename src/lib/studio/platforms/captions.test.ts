import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { composeCaption, fitCaption, normaliseHashtags } from './captions';

describe('normaliseHashtags', () => {
  it('trims, strips leading #, dedupes case-insensitively, and preserves first-seen casing', () => {
    expect(normaliseHashtags([' #Sale ', 'sale', '#SALE', 'newYear'])).toEqual(['Sale', 'newYear']);
  });

  it('drops empty tags after stripping #', () => {
    expect(normaliseHashtags(['#', '  ', '#ok'])).toEqual(['ok']);
  });

  it('accepts unicode letters and numbers and underscores', () => {
    expect(normaliseHashtags(['café2026', 'a_b_c'])).toEqual(['café2026', 'a_b_c']);
  });

  it('rejects hashtags with invalid characters', () => {
    expect(() => normaliseHashtags(['bad tag'])).toThrow(ValidationError);
    expect(() => normaliseHashtags(['bad-tag'])).toThrow(ValidationError);
  });

  it('rejects hashtags over 100 characters', () => {
    const tooLong = 'a'.repeat(101);
    expect(() => normaliseHashtags([tooLong])).toThrow(ValidationError);
  });
});

describe('composeCaption', () => {
  it('appends normalised hashtags after the caption body', () => {
    const result = composeCaption('tiktok', { caption: 'Hello world', hashtags: ['fun', 'FUN'] });
    expect(result.text).toBe('Hello world\n\n#fun');
    expect(result.hashtags).toEqual(['fun']);
  });

  it('adds required hashtags for youtube_short (#Shorts)', () => {
    const result = composeCaption('youtube_short', { caption: 'Quick tip', hashtags: [] });
    expect(result.hashtags).toContain('Shorts');
    expect(result.text).toContain('#Shorts');
  });

  it('omits the hashtag line entirely when there are no hashtags', () => {
    const result = composeCaption('x', { caption: 'Just text', hashtags: [] });
    expect(result.text).toBe('Just text');
  });

  it('rejects more hashtags than the platform allows (beyond required ones)', () => {
    expect(() => composeCaption('x', { caption: 'c', hashtags: ['a', 'b', 'c'] })).toThrow(
      ValidationError,
    );
  });

  it('allows required hashtags in addition to the platform max', () => {
    // youtube_short allows 15 + 1 required ('Shorts') = 16 total.
    const hashtags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const result = composeCaption('youtube_short', { caption: 'c', hashtags });
    expect(result.hashtags).toHaveLength(16);
  });

  it('rejects a caption that is too long including hashtags (character-counted platform)', () => {
    expect(() => composeCaption('x', { caption: 'a'.repeat(280), hashtags: ['tag'] })).toThrow(
      ValidationError,
    );
  });

  it('counts youtube captions in UTF-8 bytes, not characters', () => {
    // Each 'é' is 2 bytes in UTF-8; use enough to exceed captionMaxChars (5000) in bytes but not chars.
    const caption = 'é'.repeat(4999);
    expect(() => composeCaption('youtube', { caption, hashtags: [] })).toThrow(ValidationError);
  });

  it('strips angle brackets from YouTube captions and titles', () => {
    const result = composeCaption('youtube', {
      caption: '<b>Bold</b> title here',
      hashtags: [],
      title: '<i>My</i> Video',
    });
    expect(result.text).not.toContain('<');
    expect(result.title).not.toContain('<');
  });

  it('derives a title from the first caption line when none is given (platforms with titles)', () => {
    const result = composeCaption('youtube', { caption: 'First line\nSecond line', hashtags: [] });
    expect(result.title).toBe('First line');
  });

  it('truncates a title to the platform max length', () => {
    const result = composeCaption('youtube', {
      caption: 'irrelevant',
      hashtags: [],
      title: 'x'.repeat(150),
    });
    expect(result.title).toHaveLength(100);
  });

  it('rejects when a title-requiring platform has no usable title text', () => {
    expect(() => composeCaption('youtube', { caption: '   ', hashtags: [], title: '   ' })).toThrow(
      ValidationError,
    );
  });

  it('does not produce a title for platforms without titleMaxChars', () => {
    const result = composeCaption('x', { caption: 'Hello', hashtags: [] });
    expect(result.title).toBeUndefined();
  });
});

describe('fitCaption (15.A9)', () => {
  it('leaves a caption that fits unchanged', () => {
    expect(fitCaption('tiktok', { caption: 'Short and sweet', hashtags: ['bread'] })).toEqual({
      caption: 'Short and sweet',
      truncated: false,
    });
  });

  it('cuts an over-long caption at a word boundary with an ellipsis so composeCaption passes', () => {
    const caption = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const fitted = fitCaption('instagram_reel', { caption, hashtags: ['bakery', 'leeds'] });
    expect(fitted.truncated).toBe(true);
    expect(fitted.caption).toMatch(/word\d+…$/);
    const composed = composeCaption('instagram_reel', {
      caption: fitted.caption,
      hashtags: ['bakery', 'leeds'],
    });
    expect([...composed.text].length).toBeLessThanOrEqual(2200);
  });

  it('respects the 280-character X limit including hashtags', () => {
    const fitted = fitCaption('x', { caption: 'a '.repeat(400), hashtags: ['one'] });
    expect(() => composeCaption('x', { caption: fitted.caption, hashtags: ['one'] })).not.toThrow();
  });

  it('counts YouTube descriptions in bytes', () => {
    const fitted = fitCaption('youtube', { caption: 'é '.repeat(3000), hashtags: [] });
    expect(fitted.truncated).toBe(true);
    expect(Buffer.byteLength(fitted.caption, 'utf8')).toBeLessThanOrEqual(5000);
  });
});
