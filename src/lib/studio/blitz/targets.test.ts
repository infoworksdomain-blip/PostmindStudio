import { describe, expect, it } from 'vitest';
import { downloadOnlyPlatforms, slotPlatforms } from '../services/automation-items';
import { destinationFor, renderPlatforms, tiktokPhotoPostsVerified } from './targets';

describe('where a format goes', () => {
  it('picks feed destinations for carousels and Reels / Shorts for videos', () => {
    expect(destinationFor('carousel', 'instagram')).toBe('instagram_feed');
    expect(destinationFor('carousel', 'facebook')).toBe('facebook_feed');
    expect(destinationFor('carousel', 'youtube')).toBeNull();
    expect(destinationFor('carousel', 'x')).toBeNull();
    expect(destinationFor('slideshow', 'instagram')).toBe('instagram_reel');
    expect(destinationFor('slideshow', 'youtube')).toBeNull();
    expect(destinationFor('ai_video', 'youtube')).toBe('youtube_short');
  });

  it('treats TikTok photo posts as download only until the slide domain is verified', () => {
    expect(tiktokPhotoPostsVerified({})).toBe(false);
    expect(tiktokPhotoPostsVerified({ STUDIO_TIKTOK_PHOTO_DOMAIN_VERIFIED: '1' })).toBe(true);
    expect(slotPlatforms('carousel', ['tiktok', 'instagram_feed'], {})).toEqual(['instagram_feed']);
    expect(downloadOnlyPlatforms('carousel', ['tiktok', 'instagram_feed'], {})).toEqual(['tiktok']);
    expect(
      slotPlatforms('carousel', ['tiktok'], { STUDIO_TIKTOK_PHOTO_DOMAIN_VERIFIED: 'true' }),
    ).toEqual(['tiktok']);
    expect(downloadOnlyPlatforms('slideshow', ['tiktok'], {})).toEqual([]);
  });

  it('renders a card for connected networks, else a sensible default', () => {
    expect(renderPlatforms('slideshow', ['youtube_short', 'tiktok'])).toEqual(['tiktok']);
    expect(renderPlatforms('carousel', [])).toEqual(['instagram_feed']);
    expect(renderPlatforms('slideshow', [])).toEqual(['tiktok', 'instagram_reel']);
  });
});
