import { describe, expect, it } from 'vitest';
import {
  ASPECT_SIZE,
  framesFor,
  hasPreview,
  MAX_PREVIEW_SEC,
  PREVIEW_FPS,
  segmentFrames,
  totalFrames,
} from './preview-model';

describe('preview timeline', () => {
  it('uses the render frame sizes per aspect ratio', () => {
    expect(ASPECT_SIZE['9:16']).toEqual({ width: 1080, height: 1920 });
    expect(ASPECT_SIZE['4:5']).toEqual({ width: 1080, height: 1350 });
    expect(ASPECT_SIZE['16:9']).toEqual({ width: 1920, height: 1080 });
    expect(ASPECT_SIZE['1:1']).toEqual({ width: 1080, height: 1080 });
  });

  it('gives each slide or shot its own duration (default 3 s when missing)', () => {
    const media = {
      kind: 'slides' as const,
      rendered: false,
      slides: [
        { imageUrl: null, text: 'a', durationSec: 2.5 },
        { imageUrl: null, text: 'b', durationSec: 0 },
      ],
    };
    expect(segmentFrames(media)).toEqual([75, 90]);
    expect(totalFrames(media)).toBe(165);
    expect(framesFor(Number.NaN)).toBe(3 * PREVIEW_FPS);
  });

  it('plays a render for its length and caps long previews', () => {
    expect(totalFrames({ kind: 'video', url: 'u', posterUrl: null, durationSec: 12 })).toBe(360);
    expect(totalFrames({ kind: 'text', text: 't', durationSec: 999 })).toBe(
      MAX_PREVIEW_SEC * PREVIEW_FPS,
    );
    const storyboard = {
      kind: 'storyboard' as const,
      shots: [{ id: 's', sortOrder: 0, durationSec: 4, text: null, stillUrl: null, state: 'x' }],
    };
    expect(segmentFrames(storyboard)).toEqual([120]);
  });

  it('never makes an empty composition', () => {
    expect(segmentFrames({ kind: 'none' })).toEqual([]);
    expect(totalFrames({ kind: 'none' })).toBe(PREVIEW_FPS);
    expect(hasPreview({ kind: 'none' })).toBe(false);
    expect(hasPreview({ kind: 'text', text: 't', durationSec: 8 })).toBe(true);
  });
});
