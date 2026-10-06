import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../../errors';
import {
  PRESET,
  slideshowEdit,
  wallOfTextEdit,
} from '../../../../../test/helpers/local-render-fixtures';
import { MUSIC_ALONE_VOLUME } from '../../pipeline/edl';
import { frameOf, readTimeline, splitSpeed, TRANSITION_SEC, type LayerClip } from './timeline';

type Edit = Record<string, unknown>;

function tracksOf(edit: Edit): Array<{ clips: Edit[] }> {
  return (edit.timeline as { tracks: Array<{ clips: Edit[] }> }).tracks;
}

/** The edit with one clip field replaced (first clip of the given track). */
function withClip(edit: Edit, track: number, patch: Edit): Edit {
  const tracks = tracksOf(edit).map((t, i) =>
    i === track ? { clips: t.clips.map((c, j) => (j === 0 ? { ...c, ...patch } : c)) } : t,
  );
  return { ...edit, timeline: { ...(edit.timeline as Edit), tracks } };
}

describe('readTimeline — slideshow edits (slideshow/edl.ts)', () => {
  it('reads the slides as the bottom track with their transitions and Ken Burns', () => {
    const t = readTimeline(slideshowEdit());
    expect(t.frame).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      outWidth: 1080,
      outHeight: 1920,
      crf: 20,
    });
    expect(t.totalSec).toBe(8);
    expect(t.base.map((c) => [c.source.kind, c.startSec, c.endSec])).toEqual([
      ['text', 0, 2.5],
      ['image', 2.5, 5],
      ['image', 5, 8],
    ]);
    expect(t.base[1]?.transitionIn).toEqual({ xfade: 'fade', durationSec: TRANSITION_SEC.plain });
    expect(t.base[2]?.transitionIn).toEqual({
      xfade: 'wipeleft',
      durationSec: TRANSITION_SEC.plain,
    });
    const kb = t.base[1]?.source;
    expect(kb?.kind === 'image' && kb.kenBurns).toEqual({ move: 'zoomIn', amount: 0.15 });
    const still = t.base[2]?.source;
    expect(still?.kind === 'image' && still.kenBurns).toBeNull();
    expect(still?.kind === 'image' && still.fit).toBe('crop');
  });

  it('reads the caption bands as text layers and the music as one faded clip', () => {
    const t = readTimeline(slideshowEdit());
    expect(t.layers.map((l) => [l.source.kind, l.startSec, l.endSec, l.position])).toEqual([
      ['text', 2.5, 5, 'bottom'],
      ['text', 5, 8, 'bottom'],
    ]);
    expect(t.audio).toEqual([
      {
        src: 'https://music.test/bed.mp3',
        startSec: 0,
        lengthSec: 8,
        trimSec: 0,
        volume: MUSIC_ALONE_VOLUME,
        fadeInSec: 0,
        fadeOutSec: 1,
      },
    ]);
    expect(t.backdrop).toEqual({ r: 0x3a, g: 0x41, b: 0x50, a: 1 });
  });

  it.each([
    ['16:9', 1920, 1080],
    ['1:1', 1080, 1080],
    ['4:5', 1080, 1350],
  ] as const)('lays a %s edit out at %ix%i', (aspect, width, height) => {
    const t = readTimeline(slideshowEdit(aspect));
    expect(t.frame).toMatchObject({ width, height, outWidth: width, outHeight: height });
  });
});

describe('readTimeline — wall-of-text edits (pipeline/edl.ts + overlays)', () => {
  it('reads the muted background clip with its letterbox crop, the label and the block', () => {
    const t = readTimeline(wallOfTextEdit());
    expect(t.totalSec).toBe(8);
    expect(t.base).toHaveLength(1);
    const bg = t.base[0]?.source;
    expect(bg).toEqual({
      kind: 'video',
      src: 'https://video.test/calm.mp4',
      fit: 'crop',
      trimSec: 0,
      crop: { top: 0.1, bottom: 0.1, left: 0, right: 0 },
    });
    // Bottom layer first: the AI label, then the overlay block on top.
    const [label, block] = t.layers as [LayerClip, LayerClip];
    expect(label.position).toBe('top');
    expect(label.offsetY).toBe(-0.02);
    expect(block.source.kind).toBe('text');
    expect(block.fadeInSec).toBe(TRANSITION_SEC.Fast); // 300 ms fadeIn → fadeFast
    const card = block.source.kind === 'text' ? block.source.card : null;
    expect(card?.stroke).toEqual({ widthPx: 3, colour: { r: 0, g: 0, b: 0, a: 1 } });
    expect(card?.fontFamily).toBe('Montserrat');
    expect(card?.paragraphs[0]?.text).toBe(
      'Three habits\n- Plan tomorrow tonight\n- Batch errands',
    );
    expect(t.audio).toHaveLength(1);
  });

  it('has no label layer when the brand kit does not ask for one', () => {
    expect(readTimeline(wallOfTextEdit('9:16', { aiLabel: false })).layers).toHaveLength(1);
  });
});

describe('readTimeline — what goes to Shotstack instead (NotImplementedError)', () => {
  const base = wallOfTextEdit('9:16', { aiLabel: false });
  // Tracks: [overlay, visual, music].
  it.each([
    ['a shape asset', withClip(base, 1, { asset: { type: 'shape', shape: 'rectangle' } })],
    [
      'a video playing its own sound',
      withClip(base, 1, { asset: { type: 'video', src: 'https://v/x.mp4' } }),
    ],
    ['an unknown clip field', withClip(base, 1, { filter: 'greyscale' })],
    ['an unknown fit', withClip(base, 1, { fit: 'stretch' })],
    ['an unknown position', withClip(base, 0, { position: 'middle' })],
  ])('%s', (_, edit) => {
    expect(() => readTimeline(edit)).toThrow(NotImplementedError);
  });

  it('overlapping audio (narration over music)', () => {
    const tracks = tracksOf(base);
    const music = tracks.at(-1) as { clips: Edit[] };
    const edit = {
      ...base,
      timeline: {
        ...(base.timeline as Edit),
        tracks: [
          ...tracks,
          {
            clips: [{ asset: { type: 'audio', src: 'https://v/voice.mp3' }, start: 1, length: 2 }],
          },
          music,
        ],
      },
    };
    expect(() => readTimeline(edit)).toThrow(/overlapping audio/);
  });

  it('an edit longer than the local limit', () => {
    expect(() => readTimeline(withClip(base, 1, { length: 600 }))).toThrow(/local limit/);
  });
});

describe('frameOf', () => {
  it('scales a 720p draft down from the 1080 layout', () => {
    expect(
      frameOf({
        format: 'mp4',
        resolution: '1080',
        scaleTo: 'hd',
        aspectRatio: '9:16',
        fps: 30,
        quality: 'medium',
      }),
    ).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      outWidth: 720,
      outHeight: 1280,
      crf: 23,
    });
  });

  it('lays 4K out at 2160 short side', () => {
    expect(frameOf({ resolution: '4k', aspectRatio: '16:9', fps: 60 })).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 60,
    });
  });

  it.each([
    { format: 'gif' },
    { resolution: 'sd' },
    { fps: 29.97 },
    { scaleTo: 'sd' },
    { aspectRatio: '21:9' },
  ])('refuses %o', (patch) => {
    expect(() => frameOf({ aspectRatio: '9:16', fps: 30, ...patch })).toThrow(NotImplementedError);
  });

  it('uses the preset output of the edit', () => {
    expect(readTimeline(slideshowEdit('9:16', { ...PRESET, fps: 60 })).frame.fps).toBe(60);
  });
});

describe('splitSpeed', () => {
  it('splits Shotstack speed suffixes', () => {
    expect(splitSpeed('fadeFast')).toEqual({ name: 'fade', speed: 'Fast' });
    expect(splitSpeed('zoomInSlow')).toEqual({ name: 'zoomIn', speed: 'Slow' });
    expect(splitSpeed('wipeLeft')).toEqual({ name: 'wipeLeft', speed: 'plain' });
  });
});
