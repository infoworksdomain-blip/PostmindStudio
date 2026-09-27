import { describe, expect, it } from 'vitest';
import {
  buildSlideshowEdit,
  slideshowDuration,
  type ResolvedSlide,
  type SlideshowEdlInput,
} from './edl';

function slide(overrides: Partial<ResolvedSlide>): ResolvedSlide {
  return {
    slideType: 'TEXT_CARD',
    durationSec: 2,
    transitionIn: 'cut',
    backgroundColor: null,
    content: {},
    ...overrides,
  };
}

function edit(slides: ResolvedSlide[], extra: Partial<SlideshowEdlInput> = {}) {
  return buildSlideshowEdit({ aspectRatio: '9:16', slides, ...extra });
}

function tracksOf(result: Record<string, unknown>) {
  const timeline = result.timeline as { tracks: Array<{ clips: Record<string, unknown>[] }> };
  return timeline.tracks;
}

describe('slideshowDuration', () => {
  it('sums the durations of all slides, rounded', () => {
    expect(
      slideshowDuration([slide({ durationSec: 1.2345 }), slide({ durationSec: 2.0005 })]),
    ).toBeCloseTo(3.235, 3);
  });

  it('returns 0 for an empty slide list', () => {
    expect(slideshowDuration([])).toBe(0);
  });
});

describe('buildSlideshowEdit — track order', () => {
  it('puts the text track first, then visual, when there is overlay text', () => {
    const result = edit([slide({ slideType: 'QUOTE', content: { quote: 'hi' } })]);
    const tracks = tracksOf(result);
    // text track (overlay) first, visual second, no music track
    expect(tracks).toHaveLength(2);
  });

  it('has only a visual track when no overlay text is produced', () => {
    const result = edit([slide({ slideType: 'TEXT_CARD', content: { text: 'hi' } })]);
    const tracks = tracksOf(result);
    // TEXT_CARD pushes to `visual` via card(), not to text/overlay
    expect(tracks).toHaveLength(1);
  });

  it('appends a music track last when musicSrc is provided', () => {
    const result = edit([slide({ slideType: 'QUOTE', content: { quote: 'hi' } })], {
      musicSrc: 'https://cdn.example.com/music.mp3',
    });
    const tracks = tracksOf(result);
    expect(tracks).toHaveLength(3);
    const music = tracks.at(-1) as { clips: Record<string, unknown>[] };
    expect(music.clips[0]?.asset).toMatchObject({
      type: 'audio',
      src: 'https://cdn.example.com/music.mp3',
    });
  });
});

describe('buildSlideshowEdit — start/length accumulation', () => {
  it('accumulates start times across slides by prior durations', () => {
    const result = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: 'a' }, durationSec: 2 }),
      slide({ slideType: 'TEXT_CARD', content: { text: 'b' }, durationSec: 3 }),
    ]);
    const tracks = tracksOf(result);
    const visual = tracks[0]?.clips ?? [];
    expect(visual[0]?.start).toBe(0);
    expect(visual[0]?.length).toBe(2);
    expect(visual[1]?.start).toBe(2);
    expect(visual[1]?.length).toBe(3);
  });
});

describe('buildSlideshowEdit — transition mapping', () => {
  it('maps transitionIn "fade" to {in: "fade"}', () => {
    const result = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: 'a' }, transitionIn: 'fade' }),
    ]);
    const tracks = tracksOf(result);
    expect(tracks[0]?.clips[0]?.transition).toEqual({ in: 'fade' });
  });

  it('omits transition for "cut"', () => {
    const result = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: 'a' }, transitionIn: 'cut' }),
    ]);
    const tracks = tracksOf(result);
    expect(tracks[0]?.clips[0]?.transition).toBeUndefined();
  });

  it('maps "wipe" to wipeLeft and "slide" to slideLeft and "zoom" to zoom', () => {
    const wipe = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: 'a' }, transitionIn: 'wipe' }),
    ]);
    expect(tracksOf(wipe)[0]?.clips[0]?.transition).toEqual({ in: 'wipeLeft' });
    const sl = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: 'a' }, transitionIn: 'slide' }),
    ]);
    expect(tracksOf(sl)[0]?.clips[0]?.transition).toEqual({ in: 'slideLeft' });
    const zoom = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: 'a' }, transitionIn: 'zoom' }),
    ]);
    expect(tracksOf(zoom)[0]?.clips[0]?.transition).toEqual({ in: 'zoom' });
  });
});

describe('buildSlideshowEdit — IMAGE_KENBURNS', () => {
  it('defaults the effect to zoomIn when no kenBurnsEffect is set', () => {
    const result = edit([slide({ slideType: 'IMAGE_KENBURNS', imageSrc: 'https://cdn/img.jpg' })]);
    const clip = tracksOf(result)[0]?.clips[0];
    expect(clip?.effect).toBe('zoomIn');
  });

  it('uses a custom kenBurnsEffect when provided', () => {
    const result = edit([
      slide({
        slideType: 'IMAGE_KENBURNS',
        imageSrc: 'https://cdn/img.jpg',
        kenBurnsEffect: 'slideRight',
      }),
    ]);
    const clip = tracksOf(result)[0]?.clips[0];
    expect(clip?.effect).toBe('slideRight');
  });

  it('IMAGE_STILL never sets an effect', () => {
    const result = edit([slide({ slideType: 'IMAGE_STILL', imageSrc: 'https://cdn/img.jpg' })]);
    const clip = tracksOf(result)[0]?.clips[0];
    expect(clip?.effect).toBeUndefined();
  });
});

describe('buildSlideshowEdit — BEFORE_AFTER', () => {
  it('splits into two image clips with a wipeLeft transition on the after half and BEFORE/AFTER labels', () => {
    const result = edit([
      slide({
        slideType: 'BEFORE_AFTER',
        durationSec: 4,
        beforeSrc: 'https://cdn/before.jpg',
        afterSrc: 'https://cdn/after.jpg',
      }),
    ]);
    const tracks = tracksOf(result);
    const visual = tracks[1]?.clips ?? tracks[0]?.clips ?? [];
    const imageClips = visual.filter((c) => (c.asset as { type?: string })?.type === 'image');
    expect(imageClips).toHaveLength(2);
    expect(imageClips[0]?.start).toBe(0);
    expect(imageClips[0]?.length).toBe(2);
    expect(imageClips[1]?.start).toBe(2);
    expect(imageClips[1]?.length).toBe(2);
    expect(imageClips[1]?.transition).toEqual({ in: 'wipeLeft' });

    const text = tracks[0]?.clips ?? [];
    const bodies = text.map((c) => (c.asset as { html?: string }).html);
    expect(bodies.some((h) => h?.includes('BEFORE'))).toBe(true);
    expect(bodies.some((h) => h?.includes('AFTER'))).toBe(true);
  });

  it('omits an image clip for a missing before/after src', () => {
    const result = edit([
      slide({
        slideType: 'BEFORE_AFTER',
        durationSec: 4,
        afterSrc: 'https://cdn/after.jpg',
      }),
    ]);
    const tracks = tracksOf(result);
    const visual = tracks.find((t) =>
      t.clips.some((c) => (c.asset as { type?: string })?.type === 'image'),
    );
    const imageClips = (visual?.clips ?? []).filter(
      (c) => (c.asset as { type?: string })?.type === 'image',
    );
    expect(imageClips).toHaveLength(1);
  });
});

describe('buildSlideshowEdit — QUOTE / STATISTIC', () => {
  it('QUOTE with a background image places an image clip and overlay text with quote+author', () => {
    const result = edit([
      slide({
        slideType: 'QUOTE',
        imageSrc: 'https://cdn/img.jpg',
        content: { quote: 'Great stuff', author: 'Jane' },
      }),
    ]);
    const tracks = tracksOf(result);
    const visual = tracks.find((t) =>
      t.clips.some((c) => (c.asset as { type?: string })?.type === 'image'),
    );
    expect(visual).toBeDefined();
    const text = tracks[0]?.clips ?? [];
    const body = (text[0]?.asset as { html?: string })?.html ?? '';
    expect(body).toContain('Great stuff');
    expect(body).toContain('Jane');
  });

  it('QUOTE without a background image falls back to a coloured card', () => {
    const result = edit([slide({ slideType: 'QUOTE', content: { quote: 'No image quote' } })]);
    const tracks = tracksOf(result);
    // last track before text is the visual card track
    const cardTrack = tracks.find((t) =>
      t.clips.some(
        (c) =>
          (c.asset as { type?: string })?.type === 'html' &&
          (c.asset as { html?: string })?.html === '<p></p>',
      ),
    );
    expect(cardTrack).toBeDefined();
  });

  it('QUOTE without an author omits the <small> byline', () => {
    const result = edit([slide({ slideType: 'QUOTE', content: { quote: 'Solo quote' } })]);
    const text = tracksOf(result)[0]?.clips ?? [];
    const body = (text[0]?.asset as { html?: string })?.html ?? '';
    expect(body).not.toContain('<small>');
  });

  it('STATISTIC renders value and label in the overlay', () => {
    const result = edit([
      slide({ slideType: 'STATISTIC', content: { value: '98%', label: 'satisfaction' } }),
    ]);
    const text = tracksOf(result)[0]?.clips ?? [];
    const body = (text[0]?.asset as { html?: string })?.html ?? '';
    expect(body).toContain('98%');
    expect(body).toContain('satisfaction');
  });
});

describe('buildSlideshowEdit — PRODUCT', () => {
  it('renders product name and feature callouts, and a price tag at topRight when priced', () => {
    const result = edit([
      slide({
        slideType: 'PRODUCT',
        imageSrc: 'https://cdn/product.jpg',
        content: { name: 'Widget', features: ['Durable', 'Cheap'], price: '$9.99' },
      }),
    ]);
    const text = tracksOf(result)[0]?.clips ?? [];
    const nameOverlay = text.find((c) => (c.asset as { html?: string })?.html?.includes('Widget'));
    expect(nameOverlay).toBeDefined();
    expect((nameOverlay?.asset as { html?: string })?.html).toContain('Durable');
    const priceOverlay = text.find((c) => (c.asset as { html?: string })?.html?.includes('$9.99'));
    expect(priceOverlay).toBeDefined();
    expect(priceOverlay?.position).toBe('topRight');
  });

  it('omits the price overlay when no price is provided', () => {
    const result = edit([
      slide({
        slideType: 'PRODUCT',
        imageSrc: 'https://cdn/product.jpg',
        content: { name: 'Widget' },
      }),
    ]);
    const text = tracksOf(result)[0]?.clips ?? [];
    expect(text).toHaveLength(1);
  });
});

describe('buildSlideshowEdit — numbered listicle caption', () => {
  it('renders "1. text" style captions from number + text/name', () => {
    const result = edit([
      slide({
        slideType: 'IMAGE_STILL',
        imageSrc: 'https://cdn/img.jpg',
        content: { number: 1, text: 'First tip' },
      }),
    ]);
    const text = tracksOf(result)[0]?.clips ?? [];
    const body = (text[0]?.asset as { html?: string })?.html ?? '';
    expect(body).toContain('1. First tip');
  });

  it('uses explicit caption over the number/name/text fallback', () => {
    const result = edit([
      slide({
        slideType: 'IMAGE_STILL',
        imageSrc: 'https://cdn/img.jpg',
        content: { number: 1, text: 'First tip', caption: 'Custom caption' },
      }),
    ]);
    const text = tracksOf(result)[0]?.clips ?? [];
    const body = (text[0]?.asset as { html?: string })?.html ?? '';
    expect(body).toContain('Custom caption');
    expect(body).not.toContain('First tip');
  });

  it('omits the overlay entirely when there is no caption, number, name or text', () => {
    const result = edit([slide({ slideType: 'IMAGE_STILL', imageSrc: 'https://cdn/img.jpg' })]);
    const tracks = tracksOf(result);
    expect(tracks).toHaveLength(1); // only the visual track, no text track
  });
});

describe('buildSlideshowEdit — HTML escaping', () => {
  it('escapes <script> and other HTML in user text', () => {
    const result = edit([
      slide({ slideType: 'TEXT_CARD', content: { text: '<script>alert(1)</script>' } }),
    ]);
    const visual = tracksOf(result)[0]?.clips ?? [];
    const body = (visual[0]?.asset as { html?: string })?.html ?? '';
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('escapes quote text and author', () => {
    const result = edit([
      slide({
        slideType: 'QUOTE',
        content: { quote: '"quoted" <b>bold</b>', author: 'A & B' },
      }),
    ]);
    const text = tracksOf(result)[0]?.clips ?? [];
    const body = (text[0]?.asset as { html?: string })?.html ?? '';
    expect(body).not.toContain('<b>');
    expect(body).toContain('&amp;');
    expect(body).toContain('&quot;');
  });
});

describe('buildSlideshowEdit — brand colours and fonts', () => {
  it('uses a valid brand background colour for TEXT_CARD', () => {
    const result = edit([slide({ slideType: 'TEXT_CARD', content: { text: 'hi' } })], {
      brand: { backgroundColour: '#112233' },
    });
    const visual = tracksOf(result)[0]?.clips ?? [];
    expect((visual[0]?.asset as { background?: string })?.background).toBe('#112233');
  });

  it('falls back to #000000 for an invalid brand background colour', () => {
    const result = edit([slide({ slideType: 'TEXT_CARD', content: { text: 'hi' } })], {
      brand: { backgroundColour: 'not-a-colour' },
    });
    const visual = tracksOf(result)[0]?.clips ?? [];
    expect((visual[0]?.asset as { background?: string })?.background).toBe('#000000');
    const timeline = result.timeline as { background: string };
    expect(timeline.background).toBe('#000000');
  });

  it('falls back to white text and Arial for an invalid text colour / font', () => {
    const result = edit([slide({ slideType: 'TEXT_CARD', content: { text: 'hi' } })], {
      brand: { textColour: 'nope', fontFamily: '<script>' },
    });
    const visual = tracksOf(result)[0]?.clips ?? [];
    const css = (visual[0]?.asset as { css?: string })?.css ?? '';
    expect(css).toContain('color: #ffffff');
    expect(css).toContain("font-family: 'Arial'");
  });

  it('honours a valid brand text colour and font family', () => {
    const result = edit([slide({ slideType: 'TEXT_CARD', content: { text: 'hi' } })], {
      brand: { textColour: '#abcdef', fontFamily: 'Georgia' },
    });
    const visual = tracksOf(result)[0]?.clips ?? [];
    const css = (visual[0]?.asset as { css?: string })?.css ?? '';
    expect(css).toContain('color: #abcdef');
    expect(css).toContain("font-family: 'Georgia'");
  });

  it("prefers the slide's own valid backgroundColor over the brand colour for TEXT_CARD", () => {
    const result = edit([
      slide({
        slideType: 'TEXT_CARD',
        content: { text: 'hi' },
        backgroundColor: '#00ff00',
      }),
    ]);
    const visual = tracksOf(result)[0]?.clips ?? [];
    expect((visual[0]?.asset as { background?: string })?.background).toBe('#00ff00');
  });
});

describe('buildSlideshowEdit — output block', () => {
  it('sets output format, resolution, aspectRatio and fps', () => {
    const result = edit([slide({ slideType: 'TEXT_CARD', content: { text: 'hi' } })]);
    expect(result.output).toEqual({
      format: 'mp4',
      resolution: '1080',
      aspectRatio: '9:16',
      fps: 30,
    });
  });
});

describe('buildSlideshowEdit — VIDEO_CLIP', () => {
  it('places a muted video asset clip', () => {
    const result = edit([
      slide({ slideType: 'VIDEO_CLIP', videoSrc: 'https://cdn/video.mp4', durationSec: 3 }),
    ]);
    const visual = tracksOf(result)[0]?.clips ?? [];
    expect(visual[0]?.asset).toMatchObject({
      type: 'video',
      src: 'https://cdn/video.mp4',
      volume: 0,
    });
    expect(visual[0]?.length).toBe(3);
  });
});
