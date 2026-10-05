import { describe, expect, it } from 'vitest';
import {
  AVATAR_SIZE,
  CONTENT_WIDTH,
  IMAGE_MAX_HEIGHT,
  SAFE_X,
  SAFE_Y,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  THEMES,
} from './constants';
import { buildSlideLayout, fitToWidth, imageBox, initialOf, type LayoutContext } from './layout';
import { circleMaskSvg, roundedMaskSvg, slideShapesSvg } from './svg';
import type { MeasureText } from './text';
import type { SlidePlan } from './types';

const measure: MeasureText = (text, fontSize) => [...text].length * fontSize * 0.5;
const ctx = (over: Partial<LayoutContext> = {}): LayoutContext => ({
  theme: 'light',
  direction: 'ltr',
  profile: { displayName: 'Acme Bakery', handle: 'acmebakery', logoUploadId: null },
  measure,
  ...over,
});
const single = (text: string, image: SlidePlan['parts'][number]['image'] = null): SlidePlan => ({
  index: 0,
  kind: 'single',
  fontSize: 46,
  parts: [{ postId: 'p1', text, image, partIndex: 0 }],
});

describe('imageBox', () => {
  it('fills the content width keeping the aspect ratio', () => {
    expect(imageBox({ imageId: 'a', width: 1600, height: 900, aiGenerated: false })).toEqual({
      width: CONTENT_WIDTH,
      height: 506,
    });
  });

  it('caps tall pictures at the maximum height, narrowing them instead of stretching', () => {
    const box = imageBox({ imageId: 'a', width: 1000, height: 2000, aiGenerated: false });
    expect(box.height).toBe(IMAGE_MAX_HEIGHT);
    expect(box.width).toBe(320);
  });
});

describe('buildSlideLayout', () => {
  it('centres the content vertically and keeps it inside the safe area', () => {
    const layout = buildSlideLayout(single('Hello world'), ctx());
    expect(layout.width).toBe(SLIDE_WIDTH);
    expect(layout.height).toBe(SLIDE_HEIGHT);
    const top = layout.contentTop;
    const bottom = SLIDE_HEIGHT - (top + layout.contentHeight);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
    expect(top).toBeGreaterThanOrEqual(SAFE_Y);
  });

  it('draws avatar, bold name, grey handle and the body text (light theme)', () => {
    const layout = buildSlideLayout(single('Hello world'), ctx());
    const roles = layout.elements.map((e) => (e.type === 'text' ? e.role : e.type));
    expect(roles).toEqual(['avatar', 'name', 'handle', 'body']);
    const name = layout.elements.find((e) => e.type === 'text' && e.role === 'name');
    const handle = layout.elements.find((e) => e.type === 'text' && e.role === 'handle');
    expect(name).toMatchObject({ bold: true, text: 'Acme Bakery', colour: THEMES.light.text });
    expect(handle).toMatchObject({ bold: false, text: '@acmebakery', colour: THEMES.light.handle });
    expect(layout.background).toBe('#FFFFFF');
  });

  it('uses the dark palette for the dark theme', () => {
    const layout = buildSlideLayout(single('Hi'), ctx({ theme: 'dark' }));
    expect(layout.background).toBe('#000000');
  });

  it('mirrors the header and right-aligns text for right-to-left slides', () => {
    const layout = buildSlideLayout(single('مرحبا\n→ بند'), ctx({ direction: 'rtl' }));
    const avatar = layout.elements.find((e) => e.type === 'avatar');
    expect(avatar).toMatchObject({ x: SLIDE_WIDTH - SAFE_X - AVATAR_SIZE });
    const texts = layout.elements.filter((e) => e.type === 'text');
    expect(texts.every((e) => e.type === 'text' && e.align === 'right')).toBe(true);
    const bullet = texts.find((e) => e.type === 'text' && e.role === 'bullet');
    expect(bullet).toMatchObject({ text: '←', x: SLIDE_WIDTH - SAFE_X });
  });

  it('puts the picture full width below the text with rounded corners', () => {
    const layout = buildSlideLayout(
      single('Caption', { imageId: 'img', width: 1600, height: 900, aiGenerated: true }),
      ctx(),
    );
    const image = layout.elements.find((e) => e.type === 'image');
    const body = layout.elements.find((e) => e.type === 'text' && e.role === 'body');
    expect(image).toMatchObject({ x: SAFE_X, width: CONTENT_WIDTH, imageId: 'img', radius: 28 });
    expect(
      image && body && image.type === 'image' && body.type === 'text' && image.y > body.y,
    ).toBe(true);
  });

  it('stacks two posts with a divider between them', () => {
    const layout = buildSlideLayout(
      {
        index: 1,
        kind: 'pair',
        fontSize: 46,
        parts: [
          { postId: 'a', text: 'One', image: null, partIndex: 0 },
          { postId: 'b', text: 'Two', image: null, partIndex: 0 },
        ],
      },
      ctx(),
    );
    expect(layout.elements.filter((e) => e.type === 'avatar')).toHaveLength(2);
    const divider = layout.elements.find((e) => e.type === 'divider');
    expect(divider).toMatchObject({
      x: SAFE_X,
      width: CONTENT_WIDTH,
      colour: THEMES.light.divider,
    });
  });

  it('shortens a name too long for the header with an ellipsis', () => {
    const layout = buildSlideLayout(
      single('Hi'),
      ctx({ profile: { displayName: 'N'.repeat(60), handle: '', logoUploadId: null } }),
    );
    const name = layout.elements.find((e) => e.type === 'text' && e.role === 'name');
    expect(name && name.type === 'text' && name.text.endsWith('…')).toBe(true);
    expect(layout.elements.some((e) => e.type === 'text' && e.role === 'handle')).toBe(false);
  });
});

describe('helpers', () => {
  it('initialOf takes the first letter, upper-cased', () => {
    expect(initialOf('  acme')).toBe('A');
    expect(initialOf('')).toBe('');
  });

  it('fitToWidth leaves text that fits alone', () => {
    expect(fitToWidth('short', 100, (s) => s.length)).toBe('short');
    expect(fitToWidth('abcdefghij', 5, (s) => s.length)).toBe('abcd…');
  });
});

describe('slideShapesSvg (structure)', () => {
  it('draws the background, avatar circles and dividers only', () => {
    const layout = buildSlideLayout(
      {
        index: 0,
        kind: 'pair',
        fontSize: 46,
        parts: [
          { postId: 'a', text: 'One', image: null, partIndex: 0 },
          { postId: 'b', text: 'Two', image: null, partIndex: 0 },
        ],
      },
      ctx({ theme: 'dark' }),
    );
    const svg = slideShapesSvg(layout, '#2F3336');
    expect(svg).toMatch(/^<svg [^>]*width="1080" height="1350"/);
    expect(svg).toContain('<rect x="0" y="0" width="1080" height="1350" fill="#000000"/>');
    expect(svg.match(/data-role="avatar"/g)).toHaveLength(2);
    expect(svg.match(/data-role="divider"/g)).toHaveLength(1);
    expect(svg).not.toContain('<text');
  });

  it('builds rounded and circular masks', () => {
    expect(roundedMaskSvg(100, 50, 8)).toContain('rx="8" ry="8"');
    expect(circleMaskSvg(80)).toContain('<circle cx="40" cy="40" r="40"');
  });
});
