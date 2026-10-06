import { describe, expect, it } from 'vitest';
import { buildSlideshowEdit, HEADLINE_DIM, type ResolvedSlide } from './edl';

// 22.4 / 22.5: Blitz and automation slideshows draw the hook and closing slides as large text
// over a dimmed photo (Fastlane look) instead of the flat backdrop text card.

const slide = (overrides: Partial<ResolvedSlide>): ResolvedSlide => ({
  slideType: 'IMAGE_STILL',
  durationSec: 2.5,
  transitionIn: 'fade',
  backgroundColor: null,
  content: {},
  ...overrides,
});

type Clip = { asset: Record<string, unknown>; start: number; length: number };

function tracks(slides: ResolvedSlide[]) {
  const edit = buildSlideshowEdit({ aspectRatio: '9:16', slides });
  return (edit.timeline as { tracks: Array<{ clips: Clip[] }> }).tracks;
}

describe('headline slides', () => {
  it('put the photo under a full-frame shade and centred text above it', () => {
    const t = tracks([
      slide({
        imageSrc: 'https://img.invalid/hook.jpg',
        content: { role: 'hook', text: 'Flat sourdough?', headline: true },
      }),
    ]);
    // text, shade, photos (top to bottom).
    expect(t).toHaveLength(3);
    const [text, shade, visual] = t as [{ clips: Clip[] }, { clips: Clip[] }, { clips: Clip[] }];
    expect(visual.clips[0]?.asset).toMatchObject({
      type: 'image',
      src: 'https://img.invalid/hook.jpg',
    });
    expect(shade.clips[0]?.asset).toMatchObject({
      type: 'html',
      background: HEADLINE_DIM,
      width: 1080,
      height: 1920,
    });
    expect(text.clips[0]?.asset.html).toBe('<p>Flat sourdough?</p>');
    // No caption band box, and never a unitless line-height (PR #109).
    expect(String(text.clips[0]?.asset.css)).not.toMatch(/background|line-height/);
  });

  it('fall back to the text card when no photo was found', () => {
    const t = tracks([slide({ content: { role: 'cta', text: 'Order today', headline: true } })]);
    expect(t).toHaveLength(1);
    expect(t[0]!.clips[0]?.asset).toMatchObject({ type: 'html', html: '<p>Order today</p>' });
  });

  it('leave ordinary photo slides as they were', () => {
    const t = tracks([
      slide({ imageSrc: 'https://img.invalid/a.jpg', content: { role: 'body', text: 'Point' } }),
    ]);
    expect(t).toHaveLength(2);
  });
});
