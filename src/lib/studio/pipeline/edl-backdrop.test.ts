import type { VisualTreatment } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildShotstackComposition, type EdlShot } from './edl';
import {
  backdropColour,
  contrastRatio,
  DEFAULT_BACKDROP,
  isTooDark,
  lumaOf,
  MIN_BACKDROP_LUMA,
  MIN_TEXT_CONTRAST,
  readableTextColour,
} from './edl-backdrop';
import { BLACKDETECT_PIXEL_THRESHOLD } from './media-probe';

// BACKLOG 20.22 — QA run 3 (project cmuqw30wy0000rp07uvgvuiud, TikTok 9:16, 30 s) failed
// black_frames at 7.2–8.0 s, 25.8–26.3 s and 27.7–30.0 s: the MOTION_GRAPHICS shot (5–8 s) and the
// TEXT_CARD shot (26–30 s) had no video asset and were drawn on #111111 / #000000, and fades dipped
// to Shotstack's default black timeline background.

type Clip = { asset: Record<string, unknown>; start: number; length: number } & Record<
  string,
  unknown
>;
type Edit = { timeline: { background: string; tracks: Array<{ clips: Clip[] }> } };

const clipsOf = (edit: Record<string, unknown>) =>
  (edit as unknown as Edit).timeline.tracks.flatMap((t) => t.clips);

/** The colour a clip paints across the whole frame, if it is a full-frame fill. */
function fillOf(clip: Clip, frame: { width: number; height: number }): string | null {
  const a = clip.asset;
  if (a.width !== frame.width || a.height !== frame.height) return null;
  if (a.type === 'shape') return (a.fill as { color?: string } | undefined)?.color ?? null;
  if (a.type === 'html') return typeof a.background === 'string' ? a.background : null;
  return null;
}

/** A full-frame, non-black fill clip covering [startSec, startSec + lengthSec). */
function expectBackdropSpanning(
  edit: Record<string, unknown>,
  frame: { width: number; height: number },
  startSec: number,
  lengthSec: number,
) {
  const fills = clipsOf(edit).filter((c) => fillOf(c, frame) !== null);
  const covering = fills.find(
    (c) => c.start <= startSec + 1e-6 && c.start + c.length >= startSec + lengthSec - 1e-6,
  );
  expect(
    covering,
    `no full-frame background over ${startSec}–${startSec + lengthSec}s`,
  ).toBeDefined();
  const colour = fillOf(covering as Clip, frame) as string;
  expect(isTooDark(colour)).toBe(false);
  expect(lumaOf(colour)).toBeGreaterThan(MIN_BACKDROP_LUMA - 1e-6);
}

// The production shot list (sortOrder 0–9).
const PRODUCTION: Array<[number, VisualTreatment, boolean]> = [
  [2.5, 'AI_AVATAR', true],
  [2.5, 'AI_CLIP', true],
  [3, 'MOTION_GRAPHICS', false],
  [3, 'AI_CLIP', true],
  [3, 'AI_CLIP', true],
  [3, 'AI_CLIP', true],
  [3, 'AI_CLIP', true],
  [3, 'AI_AVATAR', true],
  [3, 'AI_CLIP', true],
  [4, 'TEXT_CARD', false],
];
const HEADLINES = [
  'Meeting panic mode',
  'AheadAI to the rescue',
  'Your opener, drafted',
  'Prompt in, plan out',
  'Five minutes saved',
  'Every single day',
  'No more blank pages',
  'Built for busy teams',
  'Try it free',
  'AheadAI',
];

function productionShots(): EdlShot[] {
  return PRODUCTION.map(([durationSec, visualTreatment, hasClip], i) => ({
    id: `shot-${i}`,
    durationSec,
    visualTreatment,
    ...(hasClip && {
      visualSrc: `https://veo.invalid/clip-${i}.mp4`,
      visualKind: 'video' as const,
    }),
    voiceSrc: `https://signed.invalid/voice-${i}.mp3`,
    onScreenText: HEADLINES[i],
    transitionOut: i === 1 || i === 8 ? 'fade' : 'cut',
  }));
}

const FRAME_9_16 = { width: 1080, height: 1920 };

describe('20.22 backdrop colour', () => {
  it('keeps a brand background that is light enough', () => {
    expect(backdropColour('#2255aa')).toBe('#2255aa');
    expect(backdropColour('#ffffff')).toBe('#ffffff');
  });

  it('lifts a dark brand colour towards white just past the threshold, keeping its hue', () => {
    for (const dark of ['#000000', '#111111', '#0a1f44', '#202020']) {
      const lifted = backdropColour(dark);
      expect(lifted).not.toBe(dark);
      expect(isTooDark(lifted)).toBe(false);
      expect(lumaOf(lifted)).toBeLessThan(MIN_BACKDROP_LUMA + 0.02);
    }
    expect(backdropColour('#000000')).toBe('#333333');
    // Navy stays bluish: blue is still the strongest channel.
    const navy = backdropColour('#0a1f44');
    expect(parseInt(navy.slice(5, 7), 16)).toBeGreaterThan(parseInt(navy.slice(1, 3), 16));
  });

  it('uses the neutral slate when the brand sets no valid colour', () => {
    expect(backdropColour(undefined)).toBe(DEFAULT_BACKDROP);
    expect(backdropColour('red;} body{')).toBe(DEFAULT_BACKDROP);
    expect(isTooDark(DEFAULT_BACKDROP)).toBe(false);
  });

  it('stays clear of blackdetect: twice its pixel threshold on both luma ranges', () => {
    expect(MIN_BACKDROP_LUMA).toBeGreaterThanOrEqual(2 * BLACKDETECT_PIXEL_THRESHOLD);
    // Limited range: 16 + Y × 219 must clear 16 + pix_th × 219 (≈ 38).
    const limited = (y: number) => 16 + y * 219;
    expect(limited(lumaOf('#333333'))).toBeGreaterThan(limited(BLACKDETECT_PIXEL_THRESHOLD) + 15);
  });

  it('keeps the brand text colour only when it reads on the backdrop (WCAG AA)', () => {
    expect(readableTextColour('#2255aa', '#ffeecc')).toBe('#ffeecc');
    // Dark text on a lifted-black card would vanish → white.
    expect(readableTextColour('#333333', '#111111')).toBe('#FFFFFF');
    // Light text on a white card → near-black.
    expect(readableTextColour('#ffffff', '#ffffee')).toBe('#111111');
    expect(readableTextColour('#3A4150', undefined)).toBe('#FFFFFF');
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio(readableTextColour('#808080', '#7f7f7f'), '#808080')).toBeGreaterThan(
      MIN_TEXT_CONTRAST,
    );
  });
});

describe('20.22 Shotstack EDL: no black behind cards, fades or the tail', () => {
  it('gives TEXT_CARD and MOTION_GRAPHICS shots a non-black background over their full duration', () => {
    for (const brand of [undefined, { backgroundColour: '#000000', palette: ['#000000'] }]) {
      const { edit, summary } = buildShotstackComposition({
        aspectRatio: '9:16',
        shots: productionShots(),
        ...(brand && { brand }),
      });
      expect(summary.totalSec).toBe(30);
      // MOTION_GRAPHICS at 5.0–8.0 s, TEXT_CARD at 26–30 s (the production timeline).
      expect(summary.shots[2]).toMatchObject({ startSec: 5, lengthSec: 3 });
      expect(summary.shots[9]).toMatchObject({ startSec: 26, lengthSec: 4 });
      expectBackdropSpanning(edit, FRAME_9_16, 5, 3);
      expectBackdropSpanning(edit, FRAME_9_16, 26, 4);
    }
  });

  it('sets a non-black timeline background, so fades and early clip ends never show black', () => {
    for (const backgroundColour of [undefined, '#000000', '#111111', '#0a1f44']) {
      const { edit, summary } = buildShotstackComposition({
        aspectRatio: '9:16',
        shots: productionShots(),
        brand: { backgroundColour },
      });
      const timeline = (edit as unknown as Edit).timeline;
      expect(isTooDark(timeline.background)).toBe(false);
      expect(summary.brand.backdropColour).toBe(timeline.background);
      // Fades out of shots 1 and 8 dip to that backdrop.
      const fades = clipsOf(edit).filter(
        (c) => (c.transition as { out?: string } | undefined)?.out === 'fade',
      );
      expect(fades.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('records the brand colours unchanged for the brand_kit check', () => {
    const { summary } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: productionShots(),
      brand: { backgroundColour: '#000000', textColour: '#111111' },
    });
    expect(summary.brand.backgroundColour).toBe('#000000');
    expect(summary.brand.textColour).toBe('#111111');
    expect(summary.brand.backdropColour).toBe('#333333');
  });

  it('draws text-card words in a colour that reads on the backdrop', () => {
    const { edit } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [{ durationSec: 4, visualTreatment: 'TEXT_CARD', cardText: 'Try it free' }],
      brand: { backgroundColour: '#000000', textColour: '#111111' },
    });
    const card = clipsOf(edit).find((c) => c.asset.type === 'html');
    expect(card?.asset.background).toBe('#333333');
    expect(String(card?.asset.css)).toContain('color: #FFFFFF;');
  });

  it('a voiced shot without a clip (failed asset) is drawn like a text card, on the backdrop', () => {
    const { edit } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [{ durationSec: 3, visualTreatment: 'AI_CLIP', onScreenText: 'Meeting panic mode' }],
    });
    expectBackdropSpanning(edit, FRAME_9_16, 0, 3);
  });
});
