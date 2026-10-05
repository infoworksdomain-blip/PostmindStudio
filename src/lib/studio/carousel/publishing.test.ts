import { describe, expect, it } from 'vitest';
import { PLATFORMS } from '../services/catalog';
import {
  CAROUSEL_PLATFORMS,
  CAROUSEL_ROUTES,
  CAROUSEL_TARGET_FORMATS,
  carouselComposition,
  carouselPublishProblems,
} from './publishing';

const composition = {
  kind: 'carousel',
  version: 1,
  bucket: 'renders',
  theme: 'light',
  language: 'en-GB',
  aiGenerated: false,
  slides: [
    {
      index: 0,
      pngKey: 'a.png',
      jpegKey: 'a.jpg',
      width: 1080,
      height: 1350,
      altText: 'Hook',
      postIds: ['p1'],
    },
  ],
  issues: [],
};

describe('carousel routes', () => {
  it('cover every Studio destination', () => {
    expect(Object.keys(CAROUSEL_ROUTES).sort()).toEqual([...PLATFORMS].sort());
  });

  it('publish to the Instagram and Facebook feeds, LinkedIn and TikTok only', () => {
    expect(CAROUSEL_PLATFORMS).toEqual([
      'instagram_feed',
      'facebook_feed',
      'linkedin_video',
      'tiktok',
    ]);
    expect(CAROUSEL_TARGET_FORMATS.every((f) => f.aspectRatio === '4:5')).toBe(true);
  });

  it('explain why other destinations are not offered', () => {
    expect(carouselPublishProblems('youtube', 5)[0]).toContain('youtube_video_only');
    expect(carouselPublishProblems('x', 5)[0]).toContain('x_not_built');
    expect(carouselPublishProblems('instagram_reel', 5)[0]).toContain('reels_video_only');
  });

  it('apply each platform’s documented item limits', () => {
    expect(carouselPublishProblems('instagram_feed', 10)).toEqual([]);
    expect(carouselPublishProblems('instagram_feed', 11)[0]).toContain('at most 10');
    expect(carouselPublishProblems('instagram_feed', 1)[0]).toContain('at least 2');
    expect(carouselPublishProblems('linkedin_video', 20)).toEqual([]);
    expect(carouselPublishProblems('linkedin_video', 1)[0]).toContain('at least 2');
    expect(carouselPublishProblems('tiktok', 1)).toEqual([]);
  });
});

describe('carouselComposition', () => {
  it('reads a carousel render and ignores video compositions', () => {
    expect(carouselComposition(composition)?.slides).toHaveLength(1);
    expect(carouselComposition({ edlHash: 'x' })).toBeNull();
    expect(carouselComposition(null)).toBeNull();
  });
});
