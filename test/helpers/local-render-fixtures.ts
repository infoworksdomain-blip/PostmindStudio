import { wallTextStyle } from '../../src/lib/studio/formats/caption-style';
import { mergeOverlayTrack } from '../../src/lib/studio/overlays/compose';
import { overlayClip, type OverlayRow } from '../../src/lib/studio/overlays/shotstack';
import { buildShotstackComposition, outputDimensions } from '../../src/lib/studio/pipeline/edl';
import { withPreset, type RenderPreset } from '../../src/lib/studio/pipeline/render-presets';
import type { AspectRatio } from '../../src/lib/studio/providers/interface';
import { buildSlideshowEdit, type ResolvedSlide } from '../../src/lib/studio/slideshow/edl';

// 23.5 test fixtures: real edits from the composer's own builders (the inputs the local renderer
// reads in production), so the tests follow the builders when they change.

export const PRESET: RenderPreset = { resolution: '1080', fps: 30, quality: 'high' };

export function slide(over: Partial<ResolvedSlide>): ResolvedSlide {
  return {
    slideType: 'TEXT_CARD',
    durationSec: 2.5,
    transitionIn: null,
    backgroundColor: null,
    content: { text: 'Hello' },
    ...over,
  } as ResolvedSlide;
}

/** A slideshow: a text card, a Ken Burns photo with a caption (fade in), a still (wipe), music. */
export function slideshowEdit(aspectRatio: AspectRatio = '9:16', preset = PRESET) {
  return withPreset(
    buildSlideshowEdit({
      aspectRatio,
      slides: [
        slide({ content: { text: '3 habits that save an hour' } as ResolvedSlide['content'] }),
        slide({
          slideType: 'IMAGE_KENBURNS',
          imageSrc: 'https://img.test/a.jpg',
          transitionIn: 'fade',
          kenBurnsEffect: 'zoomIn',
          content: { caption: 'Plan tomorrow tonight' } as ResolvedSlide['content'],
        }),
        slide({
          slideType: 'IMAGE_STILL',
          imageSrc: 'https://img.test/b.jpg',
          transitionIn: 'wipe',
          durationSec: 3,
          content: { caption: 'Batch your errands' } as ResolvedSlide['content'],
        }),
      ],
      musicSrc: 'https://music.test/bed.mp3',
      musicDurationSec: 30,
      brand: {},
    }),
    aspectRatio,
    preset,
  );
}

export const WALL_TEXT = 'Three habits\n- Plan tomorrow tonight\n- Batch errands';

export function wallOverlay(text = WALL_TEXT, endAtSec = 8): OverlayRow {
  return { ...wallTextStyle(12), id: 'overlay-1', text, startAtSec: 0, endAtSec };
}

/** A wall of text: one muted background clip (letterbox cropped), AI label, music, the block. */
export function wallOfTextEdit(
  aspectRatio: AspectRatio = '9:16',
  options: { aiLabel?: boolean } = {},
) {
  const composition = buildShotstackComposition({
    aspectRatio,
    shots: [
      {
        id: 'shot-1',
        durationSec: 8,
        visualTreatment: 'STOCK_FOOTAGE',
        visualSrc: 'https://video.test/calm.mp4',
        visualKind: 'video',
        onScreenText: null,
        transitionOut: 'cut',
        sourceCrop: { top: 0.1, bottom: 0.1, left: 0, right: 0 },
      },
    ],
    musicSrc: 'https://music.test/bed.mp3',
    musicDurationSec: 30,
    preset: PRESET,
    aiLabel: options.aiLabel ?? true,
    language: 'en-GB',
  });
  const frame = outputDimensions(aspectRatio, PRESET.resolution);
  return mergeOverlayTrack(composition.edit, {
    clips: [overlayClip(wallOverlay(), { frame, offsetSec: 0 })],
    fonts: [],
    skipped: [],
  });
}
