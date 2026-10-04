import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { planSlides } from './breakdown';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './constants';
import { fontStackFor } from './fonts';
import { renderSlides } from './render';
import type { CarouselPost } from './types';

async function picture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

const IMAGE = { imageId: 'img-1', width: 1600, height: 900, aiGenerated: false };

const POSTS: CarouselPost[] = [
  { id: 'p1', text: '7 things every bakery owner should know:', image: IMAGE },
  { id: 'p2', text: 'Price your bread by weight, not by loaf.', image: null },
  { id: 'p3', text: 'Bake less on Mondays.\n\n→ fewer leftovers\n→ calmer mornings', image: null },
  { id: 'p4', text: 'Follow for part two.', image: null },
];

async function render(language: string, theme: 'light' | 'dark') {
  const fonts = fontStackFor(language);
  const plans = planSlides(POSTS, fonts.measure);
  const pic = await picture(1600, 900);
  return renderSlides({
    plans,
    context: {
      theme,
      direction: language.startsWith('ar') ? 'rtl' : 'ltr',
      profile: { displayName: 'Acme Bakery', handle: 'acmebakery', logoUploadId: null },
    },
    fonts,
    loadImage: async () => pic,
    logo: null,
    imageSizes: new Map([['img-1', { width: 1600, height: 900 }]]),
  });
}

function pixel(data: Buffer, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i] ?? -1, data[i + 1] ?? -1, data[i + 2] ?? -1];
}

describe('renderSlides', () => {
  it('renders 1080×1350 PNG and JPEG slides on a white background (light)', async () => {
    const slides = await render('en-GB', 'light');
    expect(slides.length).toBeGreaterThanOrEqual(3);
    for (const slide of slides) {
      const meta = await sharp(slide.png).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', SLIDE_WIDTH, SLIDE_HEIGHT]);
      const jpeg = await sharp(slide.jpeg).metadata();
      expect([jpeg.format, jpeg.width, jpeg.height]).toEqual(['jpeg', SLIDE_WIDTH, SLIDE_HEIGHT]);
      expect(slide.issues).toEqual([]);
    }
    const { data } = await sharp(slides[0]?.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixel(data, SLIDE_WIDTH, 5, 5)).toEqual([255, 255, 255]);
  }, 60_000);

  it('renders the dark theme on black and draws text and the picture', async () => {
    const slides = await render('en-GB', 'dark');
    const first = slides[0];
    if (!first) throw new Error('no slide');
    const { data } = await sharp(first.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixel(data, SLIDE_WIDTH, 5, 5)).toEqual([0, 0, 0]);
    const image = first.layout.elements.find((e) => e.type === 'image');
    if (!image || image.type !== 'image') throw new Error('no image element');
    const cx = image.x + Math.round(image.width / 2);
    const cy = image.y + Math.round(image.height / 2);
    expect(pixel(data, SLIDE_WIDTH, cx, cy)).toEqual([30, 120, 200]);
    // The picture's corner is rounded off (background shows through).
    expect(pixel(data, SLIDE_WIDTH, image.x + 1, image.y + 1)).toEqual([0, 0, 0]);
    // Some light text pixels exist on the slide.
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 0) > 200) bright += 1;
    expect(bright).toBeGreaterThan(500);
  }, 60_000);

  it('is deterministic', async () => {
    const a = await render('en-GB', 'light');
    const b = await render('en-GB', 'light');
    expect(a.map((s) => s.png.equals(b[s.index]?.png ?? Buffer.alloc(0)))).toEqual(
      a.map(() => true),
    );
  }, 60_000);

  it('mirrors the header for Arabic (avatar on the right)', async () => {
    const slides = await render('ar', 'light');
    const avatar = slides[0]?.layout.elements.find((e) => e.type === 'avatar');
    expect(avatar && avatar.type === 'avatar' && avatar.x).toBe(SLIDE_WIDTH - 90 - 80);
    expect(slides[0]?.layout.direction).toBe('rtl');
  }, 60_000);
});
