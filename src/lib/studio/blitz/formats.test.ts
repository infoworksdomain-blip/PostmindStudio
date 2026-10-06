import { describe, expect, it } from 'vitest';
import {
  availableFormats,
  defaultFormatWeights,
  FORMATS,
  isPremade,
  platformsFor,
  registerFormatBuilder,
} from './formats';

describe('blitz format registry', () => {
  it('offers carousel, slideshow and the paid formats today, cheapest first', () => {
    expect(availableFormats(['BRIEF', 'SLIDESHOW', 'CAROUSEL'])).toEqual([
      'carousel',
      'slideshow',
      'ai_video',
      'ugc',
    ]);
  });

  it('22.1 / 22.2: offers wall of text and hook + demo once their source types exist', () => {
    // Without the enum values they are not offered.
    expect(availableFormats(['BRIEF', 'CAROUSEL', 'SLIDESHOW'])).not.toContain('wall_of_text');
    expect(
      availableFormats(['BRIEF', 'CAROUSEL', 'SLIDESHOW', 'WALL_OF_TEXT', 'HOOK_DEMO']),
    ).toEqual(['carousel', 'slideshow', 'wall_of_text', 'hook_demo', 'ai_video', 'ugc']);
    // Both ship their builder now; registering again changes nothing.
    registerFormatBuilder('wall_of_text');
    expect(availableFormats()).toContain('hook_demo');
    expect(isPremade('wall_of_text') && isPremade('hook_demo')).toBe(true);
    expect(FORMATS.wall_of_text.planKind).toBe('VIDEO');
    expect(FORMATS.hook_demo.needsDemoVideo).toBe(true);
  });

  it('defaults paid formats to weight 0', () => {
    const weights = defaultFormatWeights(['carousel', 'slideshow', 'ai_video', 'ugc']);
    expect(weights).toEqual({ carousel: 35, slideshow: 35, ai_video: 0, ugc: 0 });
  });

  it('keeps carousels and slideshows pre-made and paid formats preview-only', () => {
    expect(isPremade('carousel')).toBe(true);
    expect(isPremade('slideshow')).toBe(true);
    expect(isPremade('ai_video')).toBe(false);
    expect(isPremade('ugc')).toBe(false);
    expect(FORMATS.ugc.costRank).toBeGreaterThan(FORMATS.ai_video.costRank);
  });

  it('gives YouTube no slideshows or carousels (Fastlane rule)', () => {
    expect(platformsFor('slideshow', ['youtube_short', 'tiktok'])).toEqual(['tiktok']);
    expect(platformsFor('carousel', ['youtube', 'instagram_feed', 'x'])).toEqual([
      'instagram_feed',
    ]);
    expect(platformsFor('ai_video', ['youtube_short'])).toEqual(['youtube_short']);
  });
});
