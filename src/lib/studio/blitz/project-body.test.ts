import { describe, expect, it } from 'vitest';
import { createProjectInput } from '../services/projects';
import { carouselThread, projectBodyForCard } from './project-body';

const copy = {
  title: '3 reasons your sourdough is flat',
  hook: 'Flat sourdough? Here is why.',
  body: ['Under-proved dough', 'Weak starter', 'Too much water'],
  cta: 'Order a loaf from us',
  imageQueries: ['dough in a bowl', 'bubbly starter jar', 'wet dough'],
};
const options = {
  businessId: 'biz-1',
  language: 'en-GB',
  platforms: ['tiktok', 'instagram_reel'] as const,
};

describe('card → project body', () => {
  it('carousel: hook, one idea per post, closing post — already written (no thread call)', () => {
    const body = createProjectInput.parse(
      projectBodyForCard('carousel', copy, { ...options, platforms: [...options.platforms] }),
    );
    expect(body.sourceType).toBe('CAROUSEL');
    expect(body.carousel?.thread).toBe(carouselThread(copy));
    expect(carouselThread(copy).split('\n---\n')).toHaveLength(5);
  });

  it('slideshow: hook and closing slides are text over a dimmed photo, body slides are photos', () => {
    const body = createProjectInput.parse(
      projectBodyForCard('slideshow', copy, {
        ...options,
        platforms: [...options.platforms],
        sourceRef: 'blitz:s1',
      }),
    );
    const slides = body.slideshow?.slides ?? [];
    expect(slides).toHaveLength(5);
    expect(slides[0]).toMatchObject({
      slideType: 'IMAGE_STILL',
      content: { role: 'hook', headline: true, text: copy.hook },
    });
    expect(slides.at(-1)).toMatchObject({
      content: { role: 'cta', headline: true, text: copy.cta },
    });
    expect(slides[1]).toMatchObject({
      slideType: 'IMAGE_KENBURNS',
      content: { role: 'body', imageQuery: 'dough in a bowl' },
    });
    // No TEXT_CARD: nothing flat and grey (operator brief 2026-10-06).
    expect(slides.some((s) => s.slideType === 'TEXT_CARD')).toBe(false);
    expect(body.sourceRef).toBe('blitz:s1');
    expect(body.targetFormats?.every((f) => f.durationSec === 15)).toBe(true);
  });

  it('ai_video and ugc: a 15 s brief; ugc carries the actor style', () => {
    const video = createProjectInput.parse(
      projectBodyForCard('ai_video', copy, { ...options, platforms: [...options.platforms] }),
    );
    expect(video.sourceType).toBe('BRIEF');
    expect(video.brief?.rawInput).toContain('Hook: Flat sourdough?');
    expect(video.ugc).toBeUndefined();
    const ugc = createProjectInput.parse(
      projectBodyForCard('ugc', copy, { ...options, platforms: [...options.platforms] }),
    );
    expect(ugc.ugc).toEqual({});
  });

  it('refuses formats whose builder has not landed', () => {
    expect(() =>
      projectBodyForCard('hook_demo', copy, { ...options, platforms: ['tiktok'] }),
    ).toThrow(/No project builder/);
  });
});
