import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { BUILT_IN_TEMPLATES } from './templates';
import {
  customSlides,
  expandTemplate,
  parseSlideContent,
  slideProblem,
  slideshowInput,
  type SlideInput,
} from './planner';

function templateByCategory(category: string) {
  const template = BUILT_IN_TEMPLATES.find((t) => t.category === category);
  if (!template) throw new Error(`no template ${category}`);
  return template;
}

describe('slideshowInput', () => {
  it('accepts templateId without slides', () => {
    expect(slideshowInput.safeParse({ templateId: 'tmpl-1' }).success).toBe(true);
  });

  it('accepts slides without templateId', () => {
    expect(
      slideshowInput.safeParse({
        slides: [{ slideType: 'TEXT_CARD', content: { text: 'hi' } }],
      }).success,
    ).toBe(true);
  });

  it('rejects both templateId and slides', () => {
    const result = slideshowInput.safeParse({
      templateId: 'tmpl-1',
      slides: [{ slideType: 'TEXT_CARD' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects neither templateId nor slides', () => {
    expect(slideshowInput.safeParse({}).success).toBe(false);
  });
});

describe('expandTemplate', () => {
  it('photo_dump: fills 0 images with 7 empty IMAGE_STILL slides', () => {
    const template = templateByCategory('photo_dump');
    const slides = expandTemplate(template, { templateId: 't' });
    expect(slides).toHaveLength(7);
    for (const slide of slides) {
      expect(slide.slideType).toBe('IMAGE_STILL');
      expect(slide.imageAssetId).toBeNull();
    }
  });

  it('photo_dump: uses provided imageIds up to their count (within range)', () => {
    const template = templateByCategory('photo_dump');
    const imageIds = Array.from({ length: 9 }, (_, i) => `img-${i}`);
    const slides = expandTemplate(template, { templateId: 't', imageIds });
    expect(slides).toHaveLength(9);
    expect(slides[0]?.imageAssetId).toBe('img-0');
  });

  it('photo_dump: rejects more images than the max', () => {
    const template = templateByCategory('photo_dump');
    const imageIds = Array.from({ length: 16 }, (_, i) => `img-${i}`);
    expect(() => expandTemplate(template, { templateId: 't', imageIds })).toThrow(ValidationError);
  });

  it('listicle_5: with items supplies exact text and hook/cta from input', () => {
    const template = templateByCategory('listicle_5');
    const items = ['a', 'b', 'c', 'd', 'e'];
    const slides = expandTemplate(template, {
      templateId: 't',
      items,
      hook: 'Hook!',
      cta: 'Buy now',
    });
    // hook + 5 body + cta
    expect(slides).toHaveLength(7);
    expect(slides[0]?.metadata.text).toBe('Hook!');
    expect(slides.at(-1)?.metadata.text).toBe('Buy now');
    const bodySlides = slides.slice(1, 6);
    bodySlides.forEach((s, i) => {
      expect(s.metadata.text).toBe(items[i]);
      expect(s.metadata.number).toBe(i + 1);
    });
  });

  it('listicle_5: with only a topic (no items) marks pendingText and numbers 1..N', () => {
    const template = templateByCategory('listicle_5');
    const slides = expandTemplate(template, { templateId: 't', topic: 'coffee tips' });
    const bodySlides = slides.slice(1, 6);
    bodySlides.forEach((s, i) => {
      expect(s.metadata.pendingText).toBe(true);
      expect(s.metadata.number).toBe(i + 1);
    });
    // hook and cta also pendingText since not supplied
    expect(slides[0]?.metadata.pendingText).toBe(true);
    expect(slides.at(-1)?.metadata.pendingText).toBe(true);
  });

  it('listicle_5: without items or topic throws ValidationError', () => {
    const template = templateByCategory('listicle_5');
    expect(() => expandTemplate(template, { templateId: 't' })).toThrow(ValidationError);
  });

  it('listicle_5: too many items throws ValidationError', () => {
    const template = templateByCategory('listicle_5');
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(() => expandTemplate(template, { templateId: 't', items })).toThrow(ValidationError);
  });

  it('listicle_10: with a topic pending-fills all 10 body slides', () => {
    const template = templateByCategory('listicle_10');
    const slides = expandTemplate(template, { templateId: 't', topic: 'productivity' });
    const bodySlides = slides.slice(1, 11);
    expect(bodySlides).toHaveLength(10);
    bodySlides.forEach((s) => expect(s.metadata.pendingText).toBe(true));
  });

  it('before_after: requires both beforeImageId and afterImageId', () => {
    const template = templateByCategory('before_after');
    expect(() => expandTemplate(template, { templateId: 't', beforeImageId: 'before-1' })).toThrow(
      ValidationError,
    );
    expect(() => expandTemplate(template, { templateId: 't', afterImageId: 'after-1' })).toThrow(
      ValidationError,
    );
  });

  it('before_after: succeeds with both ids and carries them on the body slide', () => {
    const template = templateByCategory('before_after');
    const slides = expandTemplate(template, {
      templateId: 't',
      beforeImageId: 'before-1',
      afterImageId: 'after-1',
    });
    const body = slides.find((s) => s.slideType === 'BEFORE_AFTER');
    expect(body?.metadata.beforeImageId).toBe('before-1');
    expect(body?.metadata.afterImageId).toBe('after-1');
  });

  it('quote_reel: missing quotes throws ValidationError (never invented)', () => {
    const template = templateByCategory('quote_reel');
    expect(() => expandTemplate(template, { templateId: 't' })).toThrow(ValidationError);
  });

  it('quote_reel: carries quote text and author verbatim from user input', () => {
    const template = templateByCategory('quote_reel');
    const quotes = [
      { text: 'Great coffee.', author: 'Jane' },
      { text: 'Best in town.' },
      { text: 'Loved it.' },
    ];
    const slides = expandTemplate(template, { templateId: 't', quotes });
    expect(slides).toHaveLength(3);
    expect(slides[0]?.metadata.quote).toBe('Great coffee.');
    expect(slides[0]?.metadata.author).toBe('Jane');
    expect(slides[1]?.metadata.author).toBeUndefined();
  });

  it('statistic_reel: missing statistics throws ValidationError (never invented)', () => {
    const template = templateByCategory('statistic_reel');
    expect(() => expandTemplate(template, { templateId: 't' })).toThrow(ValidationError);
  });

  it('statistic_reel: carries value and label verbatim', () => {
    const template = templateByCategory('statistic_reel');
    const statistics = [
      { value: '98%', label: 'satisfaction' },
      { value: '4.9', label: 'stars' },
      { value: '10k', label: 'customers' },
    ];
    const slides = expandTemplate(template, { templateId: 't', statistics });
    expect(slides.map((s) => s.metadata.value)).toEqual(['98%', '4.9', '10k']);
    expect(slides.map((s) => s.metadata.label)).toEqual(['satisfaction', 'stars', 'customers']);
  });

  it('product_showcase: missing products throws ValidationError', () => {
    const template = templateByCategory('product_showcase');
    expect(() => expandTemplate(template, { templateId: 't' })).toThrow(ValidationError);
  });

  it('product_showcase: carries imageAssetId, name, features and price from products', () => {
    const template = templateByCategory('product_showcase');
    const products = [
      { name: 'Widget', features: ['durable', 'cheap'], price: '$9.99', imageId: 'img-1' },
    ];
    const slides = expandTemplate(template, { templateId: 't', products, cta: 'Shop now' });
    const productSlide = slides.find((s) => s.slideType === 'PRODUCT');
    expect(productSlide?.imageAssetId).toBe('img-1');
    expect(productSlide?.metadata.name).toBe('Widget');
    expect(productSlide?.metadata.features).toEqual(['durable', 'cheap']);
    expect(productSlide?.metadata.price).toBe('$9.99');
    const ctaSlide = slides.at(-1);
    expect(ctaSlide?.metadata.text).toBe('Shop now');
  });

  it('team_introduction: missing members throws ValidationError', () => {
    const template = templateByCategory('team_introduction');
    expect(() => expandTemplate(template, { templateId: 't' })).toThrow(ValidationError);
  });

  it('team_introduction: carries imageAssetId, name and role from members', () => {
    const template = templateByCategory('team_introduction');
    const members = [{ name: 'Sam', role: 'Founder', imageId: 'img-2' }];
    const slides = expandTemplate(template, { templateId: 't', members });
    const memberSlide = slides.find((s) => s.slideType === 'IMAGE_STILL');
    expect(memberSlide?.imageAssetId).toBe('img-2');
    expect(memberSlide?.metadata.name).toBe('Sam');
    expect(memberSlide?.metadata.text).toBe('Founder');
  });

  it('assigns sequential sortOrder across every produced slide', () => {
    const template = templateByCategory('listicle_5');
    const slides = expandTemplate(template, {
      templateId: 't',
      items: ['a', 'b', 'c', 'd', 'e'],
      hook: 'h',
      cta: 'c',
    });
    slides.forEach((slide, i) => expect(slide.sortOrder).toBe(i));
  });

  it('clamps durationSec to the slide type range via clampDuration', () => {
    const template = templateByCategory('quote_reel');
    const quotes = [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }];
    const slides = expandTemplate(template, { templateId: 't', quotes });
    // QUOTE range is [3.0, 5.0]; template durationSec is 4 so should stay 4.
    expect(slides.every((s) => s.durationSec >= 3.0 && s.durationSec <= 5.0)).toBe(true);
  });
});

describe('customSlides', () => {
  it('applies default duration 2.5 when durationSec is omitted', () => {
    const input: SlideInput[] = [{ slideType: 'TEXT_CARD', content: { text: 'hi' } }];
    const [slide] = customSlides(input);
    expect(slide?.durationSec).toBe(2.5);
  });

  it('clamps an out-of-range durationSec to the slide type range', () => {
    const input: SlideInput[] = [{ slideType: 'QUOTE', durationSec: 0.5 }];
    const [slide] = customSlides(input);
    expect(slide?.durationSec).toBe(3.0);
  });

  it('defaults optional fields to null and preserves sortOrder as array index', () => {
    const input: SlideInput[] = [
      { slideType: 'TEXT_CARD', content: { text: 'first' } },
      { slideType: 'TEXT_CARD', content: { text: 'second' } },
    ];
    const slides = customSlides(input);
    expect(slides[0]?.sortOrder).toBe(0);
    expect(slides[1]?.sortOrder).toBe(1);
    expect(slides[0]?.imageAssetId).toBeNull();
    expect(slides[0]?.videoAssetId).toBeNull();
    expect(slides[0]?.backgroundColor).toBeNull();
    expect(slides[0]?.transitionIn).toBeNull();
    expect(slides[0]?.transitionOut).toBeNull();
    expect(slides[0]?.kenBurnsSpec).toBeNull();
  });

  it('defaults metadata to {} when content is omitted', () => {
    const input: SlideInput[] = [{ slideType: 'IMAGE_STILL', imageAssetId: 'img-1' }];
    const [slide] = customSlides(input);
    expect(slide?.metadata).toEqual({});
  });

  it('carries kenBurnsSpec through unchanged', () => {
    const input: SlideInput[] = [
      { slideType: 'IMAGE_KENBURNS', imageAssetId: 'img-1', kenBurnsSpec: { effect: 'zoomOut' } },
    ];
    const [slide] = customSlides(input);
    expect(slide?.kenBurnsSpec).toEqual({ effect: 'zoomOut' });
  });
});

describe('slideProblem', () => {
  it('flags pendingText before any type-specific check', () => {
    const problem = slideProblem({
      slideType: 'TEXT_CARD',
      imageAssetId: null,
      videoAssetId: null,
      metadata: { pendingText: true },
    });
    expect(problem).toMatch(/text not written yet/);
  });

  it('IMAGE_STILL: needs an image', () => {
    expect(
      slideProblem({
        slideType: 'IMAGE_STILL',
        imageAssetId: null,
        videoAssetId: null,
        metadata: {},
      }),
    ).toBe('needs an image');
  });

  it('IMAGE_STILL: ready with an image', () => {
    expect(
      slideProblem({
        slideType: 'IMAGE_STILL',
        imageAssetId: 'img-1',
        videoAssetId: null,
        metadata: {},
      }),
    ).toBeNull();
  });

  it('IMAGE_KENBURNS: needs an image', () => {
    expect(
      slideProblem({
        slideType: 'IMAGE_KENBURNS',
        imageAssetId: null,
        videoAssetId: null,
        metadata: {},
      }),
    ).toBe('needs an image');
  });

  it('VIDEO_CLIP: needs a video clip when missing, ready when present', () => {
    expect(
      slideProblem({
        slideType: 'VIDEO_CLIP',
        imageAssetId: null,
        videoAssetId: null,
        metadata: {},
      }),
    ).toBe('needs a video clip');
    expect(
      slideProblem({
        slideType: 'VIDEO_CLIP',
        imageAssetId: null,
        videoAssetId: 'vid-1',
        metadata: {},
      }),
    ).toBeNull();
  });

  it('TEXT_CARD: needs text when missing, ready when present', () => {
    expect(
      slideProblem({
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        videoAssetId: null,
        metadata: {},
      }),
    ).toBe('needs text');
    expect(
      slideProblem({
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        videoAssetId: null,
        metadata: { text: 'hi' },
      }),
    ).toBeNull();
  });

  it('BEFORE_AFTER: needs both before and after images', () => {
    expect(
      slideProblem({
        slideType: 'BEFORE_AFTER',
        imageAssetId: null,
        videoAssetId: null,
        metadata: { beforeImageId: 'b1' },
      }),
    ).toBe('needs before and after images');
    expect(
      slideProblem({
        slideType: 'BEFORE_AFTER',
        imageAssetId: null,
        videoAssetId: null,
        metadata: { beforeImageId: 'b1', afterImageId: 'a1' },
      }),
    ).toBeNull();
  });

  it('QUOTE: needs a quote', () => {
    expect(
      slideProblem({ slideType: 'QUOTE', imageAssetId: null, videoAssetId: null, metadata: {} }),
    ).toBe('needs a quote');
    expect(
      slideProblem({
        slideType: 'QUOTE',
        imageAssetId: null,
        videoAssetId: null,
        metadata: { quote: 'q' },
      }),
    ).toBeNull();
  });

  it('STATISTIC: needs a value and label', () => {
    expect(
      slideProblem({
        slideType: 'STATISTIC',
        imageAssetId: null,
        videoAssetId: null,
        metadata: { value: '1' },
      }),
    ).toBe('needs a value and label');
    expect(
      slideProblem({
        slideType: 'STATISTIC',
        imageAssetId: null,
        videoAssetId: null,
        metadata: { value: '1', label: 'x' },
      }),
    ).toBeNull();
  });

  it('PRODUCT: needs an image and a product name', () => {
    expect(
      slideProblem({
        slideType: 'PRODUCT',
        imageAssetId: null,
        videoAssetId: null,
        metadata: {},
      }),
    ).toBe('needs an image');
    expect(
      slideProblem({
        slideType: 'PRODUCT',
        imageAssetId: 'img-1',
        videoAssetId: null,
        metadata: {},
      }),
    ).toBe('needs a product name');
    expect(
      slideProblem({
        slideType: 'PRODUCT',
        imageAssetId: 'img-1',
        videoAssetId: null,
        metadata: { name: 'Widget' },
      }),
    ).toBeNull();
  });
});

describe('parseSlideContent', () => {
  it('returns {} for invalid input', () => {
    expect(parseSlideContent({ text: 123 })).toEqual({});
    expect(parseSlideContent('not an object')).toEqual({});
    expect(parseSlideContent(null)).toEqual({});
    expect(parseSlideContent(undefined)).toEqual({});
  });

  it('parses a valid content object', () => {
    expect(parseSlideContent({ text: 'hi', number: 3 })).toEqual({ text: 'hi', number: 3 });
  });

  it('returns {} when an unknown key is present (strict schema)', () => {
    expect(parseSlideContent({ text: 'hi', unknownKey: 'x' })).toEqual({});
  });
});
