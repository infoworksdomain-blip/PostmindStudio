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

  it('22.6 wall of text from long card copy: ≤ 35 words, ≤ 6 lines, time to read it', () => {
    const long = {
      ...copy,
      body: Array.from({ length: 8 }, (_, i) => `Reason number ${i + 1} explained in detail`),
    };
    const body = createProjectInput.parse(
      projectBodyForCard('wall_of_text', long, { ...options, platforms: ['tiktok'] }),
    );
    const text = body.wallOfText?.text ?? '';
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(35);
    expect(text.split('\n').length).toBeLessThanOrEqual(6);
    expect(body.wallOfText?.durationSec).toBe(12);
    expect(body.targetFormats?.[0]?.durationSec).toBe(12);
  });

  it('22.2 wall of text: the hook and lines as the block, 6–12 s, calm background', () => {
    const body = createProjectInput.parse(
      projectBodyForCard('wall_of_text', copy, { ...options, platforms: ['tiktok'] }),
    );
    expect(body.sourceType).toBe('WALL_OF_TEXT');
    expect(body.wallOfText).toEqual({
      text: 'Flat sourdough? Here is why.\n- Under-proved dough\n- Weak starter\n- Too much water',
      background: 'calm',
      durationSec: 12,
    });
    expect(body.targetFormats?.[0]?.durationSec).toBe(12);
  });

  it('22.1 hook + demo: the hook line and a library hook, never a paid generated clip', () => {
    const body = createProjectInput.parse(
      projectBodyForCard('hook_demo', copy, {
        ...options,
        platforms: ['tiktok'],
        sourceRef: 'blitz:s2',
      }),
    );
    expect(body.sourceType).toBe('HOOK_DEMO');
    expect(body.hookDemo).toMatchObject({
      hookLine: 'Flat sourdough? Here is why.',
      hookSource: 'library',
      allowGeneratedHook: false,
    });
    expect(body.sourceRef).toBe('blitz:s2');
  });
});
