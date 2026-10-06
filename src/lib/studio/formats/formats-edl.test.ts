import { describe, expect, it } from 'vitest';
import {
  buildShotstackComposition,
  MUSIC_ALONE_VOLUME,
  outputDimensions,
  type EdlShot,
} from '../pipeline/edl';
import type { TextOverlay } from '@prisma/client';
import { halfFrameCrop } from '../pipeline/edl-stacked';
import { toOverlayRow } from '../overlays/compose';
import { overlayBoxHeight, overlayClip } from '../overlays/shotstack';
import {
  CLASSIC_STROKE_PX,
  classicOverlayRow,
  HOOK_CAPTION_ANCHOR_Y,
  hookCaptionStyle,
  STACKED_HOOK_CAPTION_ANCHOR_Y,
  wallTextStyle,
} from './caption-style';
import { hookDemoEdl } from './hook-demo-edl';
import { AUDIO_MIX_LEVELS, hookDemoCreateInput, newHookDemoDocument } from './hook-demo';

// BACKLOG 22.1 / 22.2 — the edit decision list for both Fastlane-style formats: clip order and
// timing, ONE caption only (on the hook), no background box, the demo's audio at the mix with the
// music ducked under it, the stacked layout, and the wall-of-text block over muted footage.

type Clip = Record<string, unknown> & { asset: Record<string, unknown> };

function tracks(edit: Record<string, unknown>): Array<{ clips: Clip[] }> {
  return (edit.timeline as { tracks: Array<{ clips: Clip[] }> }).tracks;
}
const clips = (edit: Record<string, unknown>) => tracks(edit).flatMap((t) => t.clips);
const videos = (edit: Record<string, unknown>) =>
  clips(edit).filter((c) => c.asset.type === 'video');
const music = (edit: Record<string, unknown>) =>
  clips(edit).filter((c) => c.asset.type === 'audio' && String(c.asset.src).includes('music'));

const frame = outputDimensions('9:16');
const doc = (over: Record<string, unknown> = {}) =>
  newHookDemoDocument(hookDemoCreateInput.parse(over), { uploadId: 'up', assetId: 'demo-asset' });

const baseShots = (): EdlShot[] => [
  {
    id: 'hook',
    durationSec: 3,
    visualTreatment: 'AI_CLIP',
    visualSrc: 'https://s3.test/hook.mp4',
    visualKind: 'video',
    onScreenText: null,
  },
  {
    id: 'demo',
    durationSec: 12,
    visualTreatment: 'USER_UPLOAD',
    visualSrc: 'https://s3.test/demo.mp4',
    visualKind: 'video',
    keepSourceAudio: true,
  },
];

function hookDemoComposition(over: Record<string, unknown> = {}, demoAspect = 9 / 16) {
  const layout = hookDemoEdl(baseShots(), {
    doc: doc(over),
    aspectRatio: '9:16',
    frame,
    demoAspect,
    hookAspect: null,
    hookFromLibrary: false,
  });
  return {
    layout,
    ...buildShotstackComposition({
      aspectRatio: '9:16',
      shots: layout.shots,
      musicSrc: 'https://s3.test/music.mp3',
      musicDurationSec: 30,
      musicUnderSpeechVolume: layout.musicUnderSpeechVolume,
      aiLabel: layout.aiHook,
    }),
  };
}

describe('hook + demo, sequential (22.1)', () => {
  it('plays the hook (3 s) then the demo (12 s) on one track', () => {
    const { edit, summary } = hookDemoComposition();
    expect(videos(edit).map((c) => [c.asset.src, c.start, c.length])).toEqual([
      ['https://s3.test/hook.mp4', 0, 3],
      ['https://s3.test/demo.mp4', 3, 12],
    ]);
    expect(summary.totalSec).toBe(15);
    expect(summary.shots.map((s) => s.treatment)).toEqual(['AI_CLIP', 'USER_UPLOAD']);
  });

  it('mutes the hook and keeps the demo’s audio at the mix', () => {
    const { edit } = hookDemoComposition({ audioMix: 'demo' });
    expect(videos(edit).map((c) => c.asset.volume)).toEqual([0, AUDIO_MIX_LEVELS.demo.demo]);
  });

  it('ducks the music under the demo’s audio and plays it full under the silent hook', () => {
    const { edit } = hookDemoComposition({ audioMix: 'balanced' });
    const bed = music(edit);
    expect(bed.map((c) => c.asset.volume)).toEqual([
      MUSIC_ALONE_VOLUME,
      AUDIO_MIX_LEVELS.balanced.musicUnder,
    ]);
  });

  it('the "music" mix mutes the demo and lets the bed play alone', () => {
    const { edit } = hookDemoComposition({ audioMix: 'music' });
    expect(videos(edit)[1]?.asset.volume).toBe(0);
    expect(new Set(music(edit).map((c) => c.asset.volume))).toEqual(new Set([MUSIC_ALONE_VOLUME]));
  });

  it('shows the AI-generated label for a generated hook, not for a library hook', () => {
    expect(hookDemoComposition().summary.brand.aiLabel).toBe(true);
    const library = hookDemoEdl(baseShots(), {
      doc: doc(),
      aspectRatio: '9:16',
      frame,
      demoAspect: null,
      hookAspect: null,
      hookFromLibrary: true,
    });
    expect(library.aiHook).toBe(false);
  });

  it('draws no headline box of its own (the hook line is the one overlay)', () => {
    const { layout } = hookDemoComposition();
    // The only html clip would be the AI label; without it there is none at all.
    const { edit } = buildShotstackComposition({ aspectRatio: '9:16', shots: layout.shots });
    expect(clips(edit).some((c) => c.asset.type === 'html')).toBe(false);
    expect(clips(hookDemoComposition().edit).filter((c) => c.asset.type === 'html')).toHaveLength(
      1,
    );
  });
});

describe('hook + demo, stacked (22.1)', () => {
  it('hook in the top half over the demo’s first seconds below, then the demo full frame', () => {
    const { edit } = hookDemoComposition({ layout: 'stacked' });
    const v = videos(edit);
    expect(v).toHaveLength(3);
    const [top, full, bottom] = [
      v.find((c) => c.position === 'top'),
      v.find((c) => c.asset.src === 'https://s3.test/demo.mp4' && c.start === 3),
      v.find((c) => c.position === 'bottom'),
    ];
    expect(top).toMatchObject({ start: 0, length: 3, fit: 'contain' });
    expect(top?.asset).toMatchObject({ src: 'https://s3.test/hook.mp4', volume: 0 });
    expect(bottom).toMatchObject({ start: 0, length: 3, fit: 'contain' });
    expect(bottom?.asset).toMatchObject({ src: 'https://s3.test/demo.mp4' });
    // The full-frame demo carries on from second 3 of the file.
    expect(full?.asset).toMatchObject({ trim: 3 });
    expect(full).toMatchObject({ length: 12 });
  });

  it('crops each portrait half to the half-frame shape (no bars)', () => {
    const { edit } = hookDemoComposition({ layout: 'stacked' });
    const top = videos(edit).find((c) => c.position === 'top');
    expect(top?.asset.crop).toEqual({ top: 0.25, bottom: 0.25, left: 0, right: 0 });
  });

  it('halfFrameCrop crops the sides of a landscape demo instead', () => {
    const crop = halfFrameCrop(16 / 9, frame);
    expect(crop.top).toBe(0);
    expect(crop.left).toBeGreaterThan(0);
    expect(crop.left).toBe(crop.right);
    expect(halfFrameCrop(frame.width / (frame.height / 2), frame)).toEqual({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });
  });

  it('a landscape output stays sequential', () => {
    const layout = hookDemoEdl(baseShots(), {
      doc: doc({ layout: 'stacked' }),
      aspectRatio: '16:9',
      frame: outputDimensions('16:9'),
      demoAspect: null,
      hookAspect: null,
      hookFromLibrary: false,
    });
    expect(layout.shots.some((s) => s.stackedTop)).toBe(false);
  });
});

describe('TikTok-classic captions (22.1 / 22.2)', () => {
  it('white text, black stroke, no background box and no shadow', () => {
    for (const style of [hookCaptionStyle(false), wallTextStyle(40)]) {
      expect(style).toMatchObject({
        fontFamily: 'Montserrat',
        fillColor: '#FFFFFF',
        strokeColor: '#000000',
        strokeWidthPx: CLASSIC_STROKE_PX,
        backgroundType: 'none',
        backgroundColor: null,
        shadowColor: null,
      });
      expect(style.fontWeight).toBeGreaterThanOrEqual(600);
      expect(style.fontWeight).toBeLessThanOrEqual(700);
    }
    expect(CLASSIC_STROKE_PX).toBeGreaterThanOrEqual(2);
    expect(CLASSIC_STROKE_PX).toBeLessThanOrEqual(3);
  });

  it('the hook line sits in the upper middle (the seam when stacked)', () => {
    expect(hookCaptionStyle(false).anchorY).toBe(HOOK_CAPTION_ANCHOR_Y);
    expect(HOOK_CAPTION_ANCHOR_Y).toBeGreaterThan(0.12);
    expect(HOOK_CAPTION_ANCHOR_Y).toBeLessThan(0.35);
    expect(hookCaptionStyle(true).anchorY).toBe(STACKED_HOOK_CAPTION_ANCHOR_Y);
  });

  it('becomes a rich-text clip over the hook only, with a stroke and no background', () => {
    const row = classicOverlayRow({
      shotId: 'hook',
      text: 'POV: bookings stopped ringing',
      startAtSec: 0,
      endAtSec: 3,
      style: hookCaptionStyle(false),
    });
    expect(row).toMatchObject({ kind: 'on_screen', presetId: null, startAtSec: 0, endAtSec: 3 });
    const parsed = toOverlayRow({ ...row, id: 'ov-1', effect: null } as unknown as TextOverlay);
    expect(parsed).not.toBeNull();
    const clip = overlayClip(parsed as NonNullable<typeof parsed>, { frame, offsetSec: 0 }) as Clip;
    expect(clip).toMatchObject({ start: 0, length: 3 });
    expect(clip.asset).toMatchObject({
      type: 'rich-text',
      stroke: { width: CLASSIC_STROKE_PX, color: '#000000' },
    });
    expect(clip.asset).not.toHaveProperty('background');
    expect(clip.asset).not.toHaveProperty('shadow');
    // Upper middle: offset.y = 0.5 − anchorY (Shotstack y is up).
    expect((clip.offset as { y: number }).y).toBeCloseTo(0.5 - HOOK_CAPTION_ANCHOR_Y, 3);
  });
});

describe('wall of text (22.2)', () => {
  const block =
    'Three habits that save an hour\n- Plan tomorrow tonight\n- Batch your errands\n- Say no sooner';

  it('one muted background clip for the whole video, music alone', () => {
    const { edit, summary } = buildShotstackComposition({
      aspectRatio: '9:16',
      musicSrc: 'https://s3.test/music.mp3',
      musicDurationSec: 30,
      shots: [
        {
          id: 'bg',
          durationSec: 8,
          visualTreatment: 'STOCK_FOOTAGE',
          visualSrc: 'https://s3.test/bg.mp4',
          visualKind: 'video',
          onScreenText: null,
        },
      ],
    });
    expect(videos(edit)).toHaveLength(1);
    expect(videos(edit)[0]).toMatchObject({ start: 0, length: 8 });
    expect(videos(edit)[0]?.asset.volume).toBe(0);
    expect(music(edit).every((c) => c.asset.volume === MUSIC_ALONE_VOLUME)).toBe(true);
    expect(summary.totalSec).toBe(8);
  });

  it('the text block box grows with its lines so nothing is cut off', () => {
    const font = Math.round((wallTextStyle(25).fontSizePct / 100) * frame.height);
    expect(overlayBoxHeight(block, font, frame)).toBeGreaterThan(font * 4 + 40);
    expect(overlayBoxHeight('Short hook', font, frame)).toBe(font * 4 + 40);
    expect(overlayBoxHeight('x\n'.repeat(80), font, frame)).toBeLessThanOrEqual(frame.height);
  });
});
