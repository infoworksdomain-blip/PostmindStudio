import { describe, expect, it } from 'vitest';
import type { AspectRatio } from '../providers/interface';
import { outputDimensions } from '../pipeline/edl';
import {
  contrastRatio,
  DEFAULT_BACKDROP,
  isTooDark,
  MIN_TEXT_CONTRAST,
} from '../pipeline/edl-backdrop';
import { buildSlideshowEdit, SLIDE_TEXT, textBase, type ResolvedSlide } from './edl';

// BACKLOG 20.26 — the production slideshow (project cmurp3szx001zql068q4fkj0f, "3 Steps to Nail
// Your Meeting Opener"): six TEXT_CARD slides, no image, no background colour, 2.5 s each, no
// brand colours. Its 16:9 and 1:1 renders were black from 0 to 15 s; the 9:16 one passed.
// Shotstack HtmlAsset (https://shotstack.io/docs/api/, read 2026-10-03): width/height are the
// bounding box in pixels, text wraps to the width and is masked past the height; `position` is
// one of nine places within the HTML area.

const ASPECTS: AspectRatio[] = ['9:16', '16:9', '1:1', '4:5'];
const POSITIONS = new Set([
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left',
  'topLeft',
  'center',
]);

const PRODUCTION: ResolvedSlide[] = [
  ['hook', '3 Steps to Nail Your Meeting Opener'],
  ['body', 'Open with the outcome you want'],
  ['body', 'Name the one decision needed today'],
  ['body', 'Ask a question in the first minute'],
  ['body', 'Keep the opener under 60 seconds'],
  ['cta', 'Follow for more meeting tips'],
].map(([role, text]) => ({
  slideType: 'TEXT_CARD' as const,
  durationSec: 2.5,
  transitionIn: 'fade',
  backgroundColor: null,
  content: { role: role as 'hook' | 'body' | 'cta', text },
}));

interface Clip {
  asset: {
    type: string;
    html?: string;
    css?: string;
    width?: number;
    height?: number;
    background?: string;
    position?: string;
  };
  start: number;
  length: number;
  fit?: string;
}

function build(aspectRatio: AspectRatio, slides: ResolvedSlide[], brand = {}) {
  const edit = buildSlideshowEdit({ aspectRatio, slides, brand });
  const timeline = edit.timeline as { background: string; tracks: Array<{ clips: Clip[] }> };
  const clips = timeline.tracks.flatMap((t) => t.clips);
  return { timeline, clips, visual: timeline.tracks.at(-1)?.clips ?? [] };
}

const fontPx = (css: string | undefined) => Number(/font-size: (\d+)px/.exec(css ?? '')?.[1]);
const textColour = (css: string | undefined) => /color: (#[0-9a-fA-F]{6})/.exec(css ?? '')?.[1];

/** Seconds of [0, total) that no visual clip covers (where the timeline background shows). */
function uncovered(visual: Clip[], total: number): number {
  const spans = visual
    .map((c) => [c.start, c.start + c.length] as const)
    .sort((a, b) => a[0] - b[0]);
  let at = 0;
  let gap = 0;
  for (const [s, e] of spans) {
    if (s > at) gap += s - at;
    at = Math.max(at, e);
  }
  return gap + Math.max(0, total - at);
}

describe.each(ASPECTS)('20.26 slideshow EDL at %s', (aspect) => {
  const frame = outputDimensions(aspect);

  it('never draws on black: the timeline and every card use a backdrop blackdetect ignores', () => {
    const { timeline, visual } = build(aspect, PRODUCTION);
    expect(timeline.background).toBe(DEFAULT_BACKDROP);
    expect(isTooDark(timeline.background)).toBe(false);
    expect(visual).toHaveLength(PRODUCTION.length);
    for (const clip of visual) {
      expect(clip.asset.background).toBeDefined();
      expect(isTooDark(clip.asset.background as string)).toBe(false);
    }
    expect(uncovered(visual, 15)).toBe(0);
  });

  it('keeps every text box inside the canvas at a valid position', () => {
    const { clips } = build(aspect, PRODUCTION);
    for (const clip of clips.filter((c) => c.asset.type === 'html')) {
      expect(clip.asset.width).toBeGreaterThan(0);
      expect(clip.asset.height).toBeGreaterThan(0);
      expect(clip.asset.width).toBeLessThanOrEqual(frame.width);
      expect(clip.asset.height).toBeLessThanOrEqual(frame.height);
      expect(POSITIONS.has(clip.asset.position ?? '')).toBe(true);
    }
  });

  it('draws card text at the 9:16 size, readable on the backdrop, and fitting its box', () => {
    const { visual } = build(aspect, PRODUCTION);
    const px = Math.round(textBase(frame) * SLIDE_TEXT.card);
    expect(px).toBe(96); // the size the passing 9:16 render used (0.05 × 1920)
    for (const [i, clip] of visual.entries()) {
      expect(fontPx(clip.asset.css)).toBe(px);
      const colour = textColour(clip.asset.css) as string;
      expect(contrastRatio(colour, clip.asset.background as string)).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
      // Bold sans-serif averages ≈ 0.6 em per character: the wrapped text must fit the box.
      const chars = PRODUCTION[i]?.content.text?.length ?? 0;
      const lines = Math.ceil((chars * 0.6 * px) / (clip.asset.width as number));
      expect(lines * px * 1.25).toBeLessThanOrEqual(clip.asset.height as number);
      expect(clip.asset.position).toBe('center');
    }
  });

  it('respects a colour the user picked for a slide', () => {
    const picked = { ...PRODUCTION[0]!, backgroundColor: '#101010' };
    const { visual } = build(aspect, [picked]);
    expect(visual[0]?.asset.background).toBe('#101010');
  });

  it('image slides crop (never stretch) and keep the caption band inside the frame', () => {
    const { clips, visual } = build(aspect, [
      {
        slideType: 'IMAGE_KENBURNS',
        durationSec: 2.5,
        transitionIn: 'fade',
        backgroundColor: null,
        imageSrc: 'https://cdn.example.com/a.jpg',
        content: { role: 'body', text: 'Open with the outcome you want' },
      },
    ]);
    expect(visual[0]?.fit).toBe('crop');
    const band = clips.find((c) => c.asset.type === 'html');
    expect(band?.asset.position).toBe('bottom');
    expect(band?.asset.height).toBeGreaterThanOrEqual(
      Math.ceil(Math.round(textBase(frame) * SLIDE_TEXT.caption) * 1.25 * 2),
    );
  });

  it('an image slide whose image is missing shows the backdrop, not an empty frame', () => {
    const { visual } = build(aspect, [
      {
        slideType: 'IMAGE_KENBURNS',
        durationSec: 3,
        transitionIn: 'cut',
        backgroundColor: null,
        content: { role: 'body', text: 'No image yet' },
      },
    ]);
    expect(visual).toHaveLength(1);
    expect(isTooDark(visual[0]?.asset.background as string)).toBe(false);
    expect(uncovered(visual, 3)).toBe(0);
  });
});

describe('20.26 text size does not depend on the aspect ratio', () => {
  it('uses the same text base on every 1080p aspect', () => {
    expect(new Set(ASPECTS.map((a) => textBase(outputDimensions(a))))).toEqual(new Set([1920]));
  });
});
