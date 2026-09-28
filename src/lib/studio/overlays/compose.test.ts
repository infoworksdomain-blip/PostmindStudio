import type { TextOverlay } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { DEFAULT_STYLE } from './params';
import type { PreRenderDeps } from './prerender';
import * as prerenderModule from './prerender';
import { buildOverlayTrack, mergeOverlayTrack, packTracks, toOverlayRow } from './compose';
import type { FrameSize } from './shotstack';

const FRAME: FrameSize = { width: 1080, height: 1920 };

function overlayRowRecord(overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: 'ov-1',
    shotId: 'shot-1',
    renderId: null,
    presetId: null,
    sortOrder: 0,
    text: 'Hello',
    lang: 'en-GB',
    startAtSec: 0,
    endAtSec: 2,
    animationInMs: DEFAULT_STYLE.animationInMs,
    animationOutMs: DEFAULT_STYLE.animationOutMs,
    animationIn: DEFAULT_STYLE.animationIn,
    animationOut: DEFAULT_STYLE.animationOut,
    easing: DEFAULT_STYLE.easing,
    fontFamily: DEFAULT_STYLE.fontFamily,
    fontWeight: DEFAULT_STYLE.fontWeight,
    fontSizePct: DEFAULT_STYLE.fontSizePct,
    fontItalic: DEFAULT_STYLE.fontItalic,
    letterSpacing: DEFAULT_STYLE.letterSpacing,
    lineHeight: DEFAULT_STYLE.lineHeight,
    fillColor: DEFAULT_STYLE.fillColor,
    strokeColor: DEFAULT_STYLE.strokeColor,
    strokeWidthPx: DEFAULT_STYLE.strokeWidthPx,
    shadowColor: DEFAULT_STYLE.shadowColor,
    shadowBlurPx: DEFAULT_STYLE.shadowBlurPx,
    shadowOffsetXPx: DEFAULT_STYLE.shadowOffsetXPx,
    shadowOffsetYPx: DEFAULT_STYLE.shadowOffsetYPx,
    backgroundType: DEFAULT_STYLE.backgroundType,
    backgroundColor: DEFAULT_STYLE.backgroundColor,
    backgroundPaddingPx: DEFAULT_STYLE.backgroundPaddingPx,
    backgroundRadiusPx: DEFAULT_STYLE.backgroundRadiusPx,
    anchorX: DEFAULT_STYLE.anchorX,
    anchorY: DEFAULT_STYLE.anchorY,
    alignment: DEFAULT_STYLE.alignment,
    rotationDeg: DEFAULT_STYLE.rotationDeg,
    effect: DEFAULT_STYLE.effect,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TextOverlay;
}

function preRenderDeps(overrides: Partial<PreRenderDeps> = {}): PreRenderDeps {
  return {
    storage: {
      put: vi.fn(),
      signedUrl: vi.fn(),
      size: vi.fn(),
      readRange: vi.fn(),
      delete: vi.fn(),
    } as unknown as PreRenderDeps['storage'],
    bucket: 'studio-renders',
    fetchImpl: vi.fn() as unknown as typeof fetch,
    fontsBaseUrl: 'https://fonts.example.com',
    ...overrides,
  };
}

describe('toOverlayRow', () => {
  it('builds an OverlayRow for a valid text_overlays row', () => {
    const row = overlayRowRecord();
    const result = toOverlayRow(row);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('ov-1');
    expect(result?.text).toBe('Hello');
    expect(result?.fontFamily).toBe(DEFAULT_STYLE.fontFamily);
  });

  it('returns null for a row with an invalid style field', () => {
    const row = overlayRowRecord({ fillColor: 'not-a-colour' });
    expect(toOverlayRow(row)).toBeNull();
  });

  it('treats a null effect column as no effect', () => {
    const row = overlayRowRecord({ effect: null });
    const result = toOverlayRow(row);
    expect(result?.effect).toBeNull();
  });
});

describe('buildOverlayTrack', () => {
  it('returns an empty track and requires no fonts config when there is nothing to place', async () => {
    const track = await buildOverlayTrack([], {
      frame: FRAME,
      organisationId: 'org-1',
      preRender: preRenderDeps({ fontsBaseUrl: undefined }),
    });
    expect(track).toEqual({ clips: [], fonts: [], skipped: [] });
  });

  it('throws ConfigurationError when fontsBaseUrl is missing and there is at least one overlay', async () => {
    const row = overlayRowRecord();
    await expect(
      buildOverlayTrack([{ row, offsetSec: 0 }], {
        frame: FRAME,
        organisationId: 'org-1',
        preRender: preRenderDeps({ fontsBaseUrl: undefined }),
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('produces a native rich-text clip for a natively-animated overlay', async () => {
    const row = overlayRowRecord({ animationIn: 'fadeIn', animationOut: 'fadeOut' });
    const track = await buildOverlayTrack([{ row, offsetSec: 0 }], {
      frame: FRAME,
      organisationId: 'org-1',
      preRender: preRenderDeps(),
    });
    expect(track.clips).toHaveLength(1);
    expect((track.clips[0] as Record<string, unknown>).asset).toMatchObject({ type: 'rich-text' });
    expect(track.fonts).toEqual([{ src: 'https://fonts.example.com/Montserrat.ttf' }]);
    expect(track.skipped).toEqual([]);
  });

  it('produces a pre-rendered video clip for an overlay that needs pre-render', async () => {
    const spy = vi
      .spyOn(prerenderModule, 'preRenderOverlay')
      .mockResolvedValue('https://signed.example/render.mov');
    const row = overlayRowRecord({ animationIn: 'glitch' });
    const track = await buildOverlayTrack([{ row, offsetSec: 5 }], {
      frame: FRAME,
      organisationId: 'org-1',
      preRender: preRenderDeps(),
    });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      expect.objectContaining({ id: row.id }),
      FRAME,
    );
    expect(track.clips).toHaveLength(1);
    expect((track.clips[0] as Record<string, unknown>).asset).toMatchObject({
      type: 'video',
      src: 'https://signed.example/render.mov',
    });
    expect(track.fonts).toEqual([]);
    spy.mockRestore();
  });

  it('orders clips by shot-relative start time, then sortOrder', async () => {
    const rowLate = overlayRowRecord({ id: 'late', startAtSec: 5, sortOrder: 0 });
    const rowEarly = overlayRowRecord({ id: 'early', startAtSec: 0, sortOrder: 0 });
    const track = await buildOverlayTrack(
      [
        { row: rowLate, offsetSec: 0 },
        { row: rowEarly, offsetSec: 0 },
      ],
      { frame: FRAME, organisationId: 'org-1', preRender: preRenderDeps() },
    );
    expect(track.clips.map((c) => (c as Record<string, unknown>).start)).toEqual([0, 5]);
  });

  it('breaks a start-time tie using sortOrder', async () => {
    const rowSecond = overlayRowRecord({ id: 'second', startAtSec: 0, sortOrder: 2, text: 'B' });
    const rowFirst = overlayRowRecord({ id: 'first', startAtSec: 0, sortOrder: 1, text: 'A' });
    const track = await buildOverlayTrack(
      [
        { row: rowSecond, offsetSec: 0 },
        { row: rowFirst, offsetSec: 0 },
      ],
      { frame: FRAME, organisationId: 'org-1', preRender: preRenderDeps() },
    );
    const texts = track.clips.map(
      (c) => ((c as Record<string, unknown>).asset as Record<string, unknown>).text,
    );
    expect(texts).toEqual(['A', 'B']);
  });

  it('skips invalid rows and records their id in skipped', async () => {
    const bad = overlayRowRecord({ id: 'bad-row', fillColor: 'not-a-colour' });
    const good = overlayRowRecord({ id: 'good-row' });
    const track = await buildOverlayTrack(
      [
        { row: bad, offsetSec: 0 },
        { row: good, offsetSec: 0 },
      ],
      { frame: FRAME, organisationId: 'org-1', preRender: preRenderDeps() },
    );
    expect(track.skipped).toEqual(['bad-row']);
    expect(track.clips).toHaveLength(1);
  });
});

describe('packTracks', () => {
  it('places non-overlapping clips on the same track', () => {
    const clips = [
      { start: 0, length: 1 },
      { start: 1, length: 1 },
    ];
    const tracks = packTracks(clips);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.clips).toHaveLength(2);
  });

  it('spreads overlapping clips across separate tracks', () => {
    const clips = [
      { start: 0, length: 2 },
      { start: 1, length: 2 },
    ];
    const tracks = packTracks(clips);
    expect(tracks).toHaveLength(2);
  });

  it('reuses a track once it is free again (first-fit)', () => {
    const clips = [
      { start: 0, length: 1 },
      { start: 0.5, length: 1 },
      { start: 1.5, length: 1 },
    ];
    const tracks = packTracks(clips);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.clips).toHaveLength(2);
    expect(tracks[1]?.clips).toHaveLength(1);
  });

  it('returns no tracks for no clips', () => {
    expect(packTracks([])).toEqual([]);
  });
});

describe('mergeOverlayTrack', () => {
  it('is a no-op when the track has no clips', () => {
    const edit = { timeline: { tracks: [{ clips: [] }] } };
    const result = mergeOverlayTrack(edit, { clips: [], fonts: [], skipped: [] });
    expect(result).toBe(edit);
  });

  it('prepends overlay tracks above the edit tracks', () => {
    const edit = { timeline: { tracks: [{ clips: ['base'] }] } };
    const track = {
      clips: [{ start: 0, length: 1 }],
      fonts: [{ src: 'https://fonts.example.com/Inter.ttf' }],
      skipped: [],
    };
    const result = mergeOverlayTrack(edit, track) as { timeline: { tracks: unknown[] } };
    expect(result.timeline.tracks).toHaveLength(2);
    expect(result.timeline.tracks[0]).toEqual({ clips: [{ start: 0, length: 1 }] });
    expect(result.timeline.tracks[1]).toEqual({ clips: ['base'] });
  });

  it('appends the track fonts to any existing timeline.fonts', () => {
    const edit = { timeline: { tracks: [], fonts: [{ src: 'existing.ttf' }] } };
    const track = {
      clips: [{ start: 0, length: 1 }],
      fonts: [{ src: 'new.ttf' }],
      skipped: [],
    };
    const result = mergeOverlayTrack(edit, track) as { timeline: { fonts: unknown[] } };
    expect(result.timeline.fonts).toEqual([{ src: 'existing.ttf' }, { src: 'new.ttf' }]);
  });

  it('defaults timeline.fonts to an empty array when absent', () => {
    const edit = { timeline: { tracks: [] } };
    const track = {
      clips: [{ start: 0, length: 1 }],
      fonts: [{ src: 'new.ttf' }],
      skipped: [],
    };
    const result = mergeOverlayTrack(edit, track) as { timeline: { fonts: unknown[] } };
    expect(result.timeline.fonts).toEqual([{ src: 'new.ttf' }]);
  });
});

describe('buildOverlayTrack — script languages (15.C5)', () => {
  it('composes an Arabic overlay right-to-left in Noto Sans Arabic', async () => {
    const row = overlayRowRecord({ text: 'Nike خصم ٥٠٪', animationIn: 'fadeIn' });
    const track = await buildOverlayTrack([{ row, offsetSec: 0 }], {
      frame: FRAME,
      organisationId: 'org-1',
      language: 'ar',
      preRender: preRenderDeps(),
    });
    const asset = (track.clips[0] as { asset: { text: string; font: { family: string } } }).asset;
    expect(asset.font.family).toBe('Noto Sans Arabic');
    expect(asset.text).toBe('‏Nike خصم ٥٠٪');
    expect(track.fonts).toEqual([{ src: 'https://fonts.example.com/NotoSansArabic.ttf' }]);
  });

  it('uses Devanagari for Hindi, SC for Mandarin and keeps the preset font for French', async () => {
    const build = (language: string) =>
      buildOverlayTrack([{ row: overlayRowRecord({ animationIn: 'fadeIn' }), offsetSec: 0 }], {
        frame: FRAME,
        organisationId: 'org-1',
        language,
        preRender: preRenderDeps(),
      });
    expect((await build('hi')).fonts).toEqual([
      { src: 'https://fonts.example.com/NotoSansDevanagari.ttf' },
    ]);
    expect((await build('zh-Hans')).fonts).toEqual([
      { src: 'https://fonts.example.com/NotoSansSC.ttf' },
    ]);
    const fr = await build('fr');
    expect(fr.fonts).toEqual([{ src: 'https://fonts.example.com/Montserrat.ttf' }]);
    expect((fr.clips[0] as { asset: { text: string } }).asset.text).toBe('Hello');
  });

  it("prefers an overlay's own non-default lang over the script language", async () => {
    const row = overlayRowRecord({ lang: 'hi', animationIn: 'fadeIn' });
    const track = await buildOverlayTrack([{ row, offsetSec: 0 }], {
      frame: FRAME,
      organisationId: 'org-1',
      language: 'en-GB',
      preRender: preRenderDeps(),
    });
    expect(track.fonts).toEqual([{ src: 'https://fonts.example.com/NotoSansDevanagari.ttf' }]);
  });

  it('passes the Arabic font and direction to the pre-renderer', async () => {
    const spy = vi
      .spyOn(prerenderModule, 'preRenderOverlay')
      .mockResolvedValue('https://signed.example/ar.mov');
    const row = overlayRowRecord({ animationIn: 'karaokeHighlight', text: 'مرحبا بكم' });
    await buildOverlayTrack([{ row, offsetSec: 0 }], {
      frame: FRAME,
      organisationId: 'org-1',
      language: 'ar',
      preRender: preRenderDeps(),
    });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      expect.objectContaining({ fontFamily: 'Noto Sans Arabic', direction: 'rtl' }),
      FRAME,
    );
    spy.mockRestore();
  });
});
