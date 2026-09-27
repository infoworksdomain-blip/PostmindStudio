import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE } from './params';
import {
  fontPx,
  fontSources,
  needsPreRender,
  overlayClip,
  preRenderedClip,
  splitColour,
  type FrameSize,
  type OverlayRow,
} from './shotstack';

const FRAME: FrameSize = { width: 1080, height: 1920 };

function overlayRow(overrides: Partial<OverlayRow> = {}): OverlayRow {
  return {
    ...DEFAULT_STYLE,
    id: 'ov-1',
    text: 'Hello world',
    startAtSec: 1,
    endAtSec: 3,
    ...overrides,
  };
}

describe('splitColour', () => {
  it('splits a #RRGGBB colour with full opacity', () => {
    expect(splitColour('#FF0000')).toEqual({ color: '#ff0000', opacity: 1 });
  });

  it('splits a #RRGGBBAA colour into colour and opacity', () => {
    expect(splitColour('#FF000080')).toEqual({ color: '#ff0000', opacity: 0.502 });
  });

  it('lowercases the hex colour', () => {
    expect(splitColour('#ABCDEF').color).toBe('#abcdef');
  });

  it('gives full opacity for #RRGGBBFF', () => {
    expect(splitColour('#000000FF').opacity).toBe(1);
  });

  it('gives zero opacity for #RRGGBB00', () => {
    expect(splitColour('#00000000').opacity).toBe(0);
  });
});

describe('fontPx', () => {
  it('scales fontSizePct against frame height', () => {
    expect(fontPx({ fontSizePct: 5 }, { width: 1080, height: 1920 })).toBe(96);
  });

  it('clamps to a minimum of 1', () => {
    expect(fontPx({ fontSizePct: 0.001 }, { width: 100, height: 100 })).toBe(1);
  });

  it('clamps to a maximum of 500', () => {
    expect(fontPx({ fontSizePct: 40 }, { width: 1080, height: 4000 })).toBe(500);
  });
});

describe('overlayClip — rich-text asset', () => {
  it('emits font family, size, weight, style, colour and opacity', () => {
    const clip = overlayClip(
      overlayRow({ fontFamily: 'Inter', fontWeight: 800, fontItalic: true, fillColor: '#112233' }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    const font = asset.font as Record<string, unknown>;
    expect(font.family).toBe('Inter');
    expect(font.weight).toBe(800);
    expect(font.style).toBe('italic');
    expect(font.color).toBe('#112233');
    expect(font.opacity).toBe(1);
    expect(typeof font.size).toBe('number');
  });

  it('sets style to normal when fontItalic is false', () => {
    const clip = overlayClip(overlayRow({ fontItalic: false }), { frame: FRAME, offsetSec: 0 });
    const asset = clip.asset as Record<string, unknown>;
    expect((asset.font as Record<string, unknown>).style).toBe('normal');
  });

  it('sets align.vertical to middle', () => {
    const clip = overlayClip(overlayRow({ alignment: 'left' }), { frame: FRAME, offsetSec: 0 });
    const asset = clip.asset as Record<string, unknown>;
    const align = asset.align as Record<string, unknown>;
    expect(align.vertical).toBe('middle');
    expect(align.horizontal).toBe('left');
  });

  it('includes letterSpacing in style only when set', () => {
    const clip = overlayClip(overlayRow({ letterSpacing: 2 }), { frame: FRAME, offsetSec: 0 });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.style).toEqual({ letterSpacing: 2 });
  });

  it('includes lineHeight in style only when set', () => {
    const clip = overlayClip(overlayRow({ lineHeight: 1.4 }), { frame: FRAME, offsetSec: 0 });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.style).toEqual({ lineHeight: 1.4 });
  });

  it('omits style entirely when neither letterSpacing nor lineHeight are set', () => {
    const clip = overlayClip(overlayRow({ letterSpacing: null, lineHeight: null }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.style).toBeUndefined();
  });

  it('includes both letterSpacing and lineHeight when both are set', () => {
    const clip = overlayClip(overlayRow({ letterSpacing: 1, lineHeight: 1.2 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.style).toEqual({ letterSpacing: 1, lineHeight: 1.2 });
  });

  it('includes a stroke only when strokeColor and strokeWidthPx are both set', () => {
    const clip = overlayClip(overlayRow({ strokeColor: '#000000', strokeWidthPx: 3 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.stroke).toEqual({ width: 3, color: '#000000', opacity: 1 });
  });

  it('omits stroke when strokeColor is set but strokeWidthPx is null', () => {
    const clip = overlayClip(overlayRow({ strokeColor: '#000000', strokeWidthPx: null }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.stroke).toBeUndefined();
  });

  it('omits stroke when strokeWidthPx is set but strokeColor is null', () => {
    const clip = overlayClip(overlayRow({ strokeColor: null, strokeWidthPx: 3 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.stroke).toBeUndefined();
  });

  it('includes a shadow when shadowColor is set', () => {
    const clip = overlayClip(
      overlayRow({
        shadowColor: '#00000080',
        shadowBlurPx: 6,
        shadowOffsetXPx: 1,
        shadowOffsetYPx: 2,
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.shadow).toEqual({
      offsetX: 1,
      offsetY: 2,
      blur: 6,
      color: '#000000',
      opacity: 0.502,
    });
  });

  it('defaults missing shadow offsets/blur to 0 when only shadowColor is set', () => {
    const clip = overlayClip(
      overlayRow({
        shadowColor: '#000000',
        shadowBlurPx: null,
        shadowOffsetXPx: null,
        shadowOffsetYPx: null,
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.shadow).toEqual({ offsetX: 0, offsetY: 0, blur: 0, color: '#000000', opacity: 1 });
  });

  it('omits shadow when shadowColor is null', () => {
    const clip = overlayClip(overlayRow({ shadowColor: null }), { frame: FRAME, offsetSec: 0 });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.shadow).toBeUndefined();
  });

  it('includes background only when backgroundType is not none and backgroundColor is set', () => {
    const clip = overlayClip(
      overlayRow({ backgroundType: 'box', backgroundColor: '#00000080', backgroundPaddingPx: 10 }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.background).toEqual({
      color: '#000000',
      opacity: 0.502,
      borderRadius: 0,
      wrap: true,
      padding: 10,
    });
  });

  it('sets borderRadius and defaults padding for a rounded_box background', () => {
    const clip = overlayClip(
      overlayRow({
        backgroundType: 'rounded_box',
        backgroundColor: '#FFFFFF',
        backgroundRadiusPx: 20,
        backgroundPaddingPx: null,
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.background).toEqual({
      color: '#ffffff',
      opacity: 1,
      borderRadius: 20,
      wrap: true,
      padding: 8,
    });
  });

  it('defaults borderRadius to 12 for a rounded_box background with no backgroundRadiusPx', () => {
    const clip = overlayClip(
      overlayRow({
        backgroundType: 'rounded_box',
        backgroundColor: '#FFFFFF',
        backgroundRadiusPx: null,
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect((asset.background as Record<string, unknown>).borderRadius).toBe(12);
  });

  it('omits background when backgroundType is none even if backgroundColor is set', () => {
    const clip = overlayClip(overlayRow({ backgroundType: 'none', backgroundColor: '#FFFFFF' }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.background).toBeUndefined();
  });

  it('omits background when backgroundType is not none but backgroundColor is null', () => {
    const clip = overlayClip(overlayRow({ backgroundType: 'box', backgroundColor: null }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.background).toBeUndefined();
  });

  it('sets a typewriter animation with duration derived from the effect CPS', () => {
    const clip = overlayClip(
      overlayRow({
        animationIn: 'typewriter',
        text: 'a'.repeat(20),
        startAtSec: 0,
        endAtSec: 10,
        effect: { typewriterCPS: 10 },
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.animation).toEqual({ preset: 'typewriter', style: 'character', duration: 2 });
  });

  it('defaults typewriter CPS to 15 when the effect is not set', () => {
    const clip = overlayClip(
      overlayRow({
        animationIn: 'typewriter',
        text: 'a'.repeat(15),
        startAtSec: 0,
        endAtSec: 10,
        effect: null,
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.animation).toEqual({ preset: 'typewriter', style: 'character', duration: 1 });
  });

  it('clamps the typewriter duration to the overlay length', () => {
    const clip = overlayClip(
      overlayRow({
        animationIn: 'typewriter',
        text: 'a'.repeat(1000),
        startAtSec: 0,
        endAtSec: 1,
        effect: { typewriterCPS: 1 },
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    const asset = clip.asset as Record<string, unknown>;
    expect((asset.animation as Record<string, unknown>).duration).toBe(1);
  });

  it('omits animation when animationIn is not typewriter', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'fadeIn' }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect(asset.animation).toBeUndefined();
  });

  it('truncates text longer than 5000 characters', () => {
    const clip = overlayClip(overlayRow({ text: 'x'.repeat(6000) }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const asset = clip.asset as Record<string, unknown>;
    expect((asset.text as string).length).toBe(5000);
  });
});

describe('overlayClip — clip placement', () => {
  it('sets start to offsetSec + startAtSec', () => {
    const clip = overlayClip(overlayRow({ startAtSec: 2, endAtSec: 5 }), {
      frame: FRAME,
      offsetSec: 10,
    });
    expect(clip.start).toBe(12);
  });

  it('sets length to endAtSec - startAtSec', () => {
    const clip = overlayClip(overlayRow({ startAtSec: 2, endAtSec: 5 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    expect(clip.length).toBe(3);
  });

  it('sets offset.x to anchorX - 0.5', () => {
    const clip = overlayClip(overlayRow({ anchorX: 0.8 }), { frame: FRAME, offsetSec: 0 });
    const offset = clip.offset as Record<string, unknown>;
    expect(offset.x).toBe(0.3);
  });

  it('sets offset.y to 0.5 - anchorY (y up)', () => {
    const clip = overlayClip(overlayRow({ anchorY: 0.2 }), { frame: FRAME, offsetSec: 0 });
    const offset = clip.offset as Record<string, unknown>;
    expect(offset.y).toBe(0.3);
  });

  it('a higher anchorY (lower on screen) produces a more negative offset.y', () => {
    const clip = overlayClip(overlayRow({ anchorY: 0.9 }), { frame: FRAME, offsetSec: 0 });
    const offset = clip.offset as Record<string, unknown>;
    expect(offset.y).toBeCloseTo(-0.4);
  });

  it('omits transform when rotationDeg is 0', () => {
    const clip = overlayClip(overlayRow({ rotationDeg: 0 }), { frame: FRAME, offsetSec: 0 });
    expect(clip.transform).toBeUndefined();
  });

  it('includes a rotate transform when rotationDeg is non-zero', () => {
    const clip = overlayClip(overlayRow({ rotationDeg: -4 }), { frame: FRAME, offsetSec: 0 });
    expect(clip.transform).toEqual({ rotate: { angle: -4 } });
  });
});

describe('overlayClip — transitions', () => {
  it('maps slideInLeft to slideRight (direction of travel)', () => {
    const clip = overlayClip(
      overlayRow({ animationIn: 'slideInLeft', animationInMs: 500, animationOut: 'none' }),
      { frame: FRAME, offsetSec: 0 },
    );
    const transition = clip.transition as Record<string, unknown>;
    expect(transition.in).toBe('slideRight');
  });

  it('appends Fast for a short animationInMs', () => {
    const clip = overlayClip(
      overlayRow({ animationIn: 'fadeIn', animationInMs: 200, animationOut: 'none' }),
      { frame: FRAME, offsetSec: 0 },
    );
    const transition = clip.transition as Record<string, unknown>;
    expect(transition.in).toBe('fadeFast');
  });

  it('appends Slow for a long animationInMs', () => {
    const clip = overlayClip(
      overlayRow({ animationIn: 'fadeIn', animationInMs: 900, animationOut: 'none' }),
      { frame: FRAME, offsetSec: 0 },
    );
    const transition = clip.transition as Record<string, unknown>;
    expect(transition.in).toBe('fadeSlow');
  });

  it('uses the bare transition name for a mid-range duration', () => {
    const clip = overlayClip(
      overlayRow({ animationIn: 'fadeIn', animationInMs: 500, animationOut: 'none' }),
      { frame: FRAME, offsetSec: 0 },
    );
    const transition = clip.transition as Record<string, unknown>;
    expect(transition.in).toBe('fade');
  });

  it('maps a transition out with its own speed variant', () => {
    const clip = overlayClip(
      overlayRow({ animationIn: 'none', animationOut: 'slideOutLeft', animationOutMs: 100 }),
      { frame: FRAME, offsetSec: 0 },
    );
    const transition = clip.transition as Record<string, unknown>;
    expect(transition.out).toBe('slideLeftFast');
  });

  it('omits transition entirely when neither animation maps to a transition', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'none', animationOut: 'none' }), {
      frame: FRAME,
      offsetSec: 0,
    });
    expect(clip.transition).toBeUndefined();
  });

  it('includes both in and out when both animations map', () => {
    const clip = overlayClip(
      overlayRow({
        animationIn: 'fadeIn',
        animationInMs: 500,
        animationOut: 'fadeOut',
        animationOutMs: 500,
      }),
      { frame: FRAME, offsetSec: 0 },
    );
    expect(clip.transition).toEqual({ in: 'fade', out: 'fade' });
  });
});

describe('overlayClip — scale tween', () => {
  it('includes a scale tween for scaleIn with easeOut', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'scaleIn', animationInMs: 400 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    expect(clip.scale).toEqual([
      { from: 0, to: 1, start: 0, length: 0.4, interpolation: 'bezier', easing: 'easeOut' },
    ]);
  });

  it('includes a scale tween for popIn with easeOutBack (overshoot)', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'popIn', animationInMs: 300 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    expect(clip.scale).toEqual([
      { from: 0, to: 1, start: 0, length: 0.3, interpolation: 'bezier', easing: 'easeOutBack' },
    ]);
  });

  it('clamps the tween length to a minimum of 0.1s', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'scaleIn', animationInMs: 0 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const scale = clip.scale as Array<Record<string, unknown>>;
    expect(scale[0]?.length).toBe(0.1);
  });

  it('omits scale for other animations', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'fadeIn' }), {
      frame: FRAME,
      offsetSec: 0,
    });
    expect(clip.scale).toBeUndefined();
  });
});

describe('overlayClip — wave offset tween', () => {
  it('produces a tween array for offset.y when animationIn is wave', () => {
    const clip = overlayClip(
      overlayRow({ animationIn: 'wave', startAtSec: 0, endAtSec: 1.2, anchorY: 0.5 }),
      { frame: FRAME, offsetSec: 0 },
    );
    const offset = clip.offset as Record<string, unknown>;
    expect(Array.isArray(offset.y)).toBe(true);
    expect((offset.y as unknown[]).length).toBeGreaterThan(0);
  });

  it('keeps offset.x a plain number even when offset.y is a tween array', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'wave', startAtSec: 0, endAtSec: 1.2 }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const offset = clip.offset as Record<string, unknown>;
    expect(typeof offset.x).toBe('number');
  });

  it('does not produce a tween array for offset.y for non-wave animations', () => {
    const clip = overlayClip(overlayRow({ animationIn: 'fadeIn' }), {
      frame: FRAME,
      offsetSec: 0,
    });
    const offset = clip.offset as Record<string, unknown>;
    expect(typeof offset.y).toBe('number');
  });
});

describe('needsPreRender', () => {
  it('is true for glitch animationIn', () => {
    expect(needsPreRender({ animationIn: 'glitch', animationOut: 'none' })).toBe(true);
  });

  it('is true for karaokeHighlight animationIn', () => {
    expect(needsPreRender({ animationIn: 'karaokeHighlight', animationOut: 'none' })).toBe(true);
  });

  it('is true for counter animationIn', () => {
    expect(needsPreRender({ animationIn: 'counter', animationOut: 'none' })).toBe(true);
  });

  it('is true when only animationOut needs pre-render', () => {
    expect(needsPreRender({ animationIn: 'none', animationOut: 'glitch' })).toBe(true);
  });

  it('is false for natively-supported animations', () => {
    expect(needsPreRender({ animationIn: 'fadeIn', animationOut: 'fadeOut' })).toBe(false);
  });
});

describe('preRenderedClip', () => {
  it('builds a muted video clip at the overlay timing', () => {
    const clip = preRenderedClip(
      { startAtSec: 2, endAtSec: 5 },
      { src: 'https://example.com/overlay.mov', offsetSec: 10 },
    );
    expect(clip).toEqual({
      asset: { type: 'video', src: 'https://example.com/overlay.mov', volume: 0 },
      start: 12,
      length: 3,
      fit: 'none',
      position: 'center',
    });
  });
});

describe('fontSources', () => {
  it('builds one entry per unique family', () => {
    const sources = fontSources(['Inter', 'Anton'], 'https://fonts.example.com');
    expect(sources).toHaveLength(2);
  });

  it('dedupes repeated families', () => {
    const sources = fontSources(['Inter', 'Inter'], 'https://fonts.example.com');
    expect(sources).toHaveLength(1);
  });

  it('sorts families alphabetically', () => {
    const sources = fontSources(['Roboto Mono', 'Anton'], 'https://fonts.example.com');
    expect(sources.map((s) => s.src)).toEqual([
      'https://fonts.example.com/Anton.ttf',
      'https://fonts.example.com/RobotoMono.ttf',
    ]);
  });

  it('strips spaces from the family name in the URL', () => {
    const sources = fontSources(['Roboto Mono'], 'https://fonts.example.com');
    expect(sources[0]?.src).toBe('https://fonts.example.com/RobotoMono.ttf');
  });

  it('strips a trailing slash from the base URL', () => {
    const sources = fontSources(['Anton'], 'https://fonts.example.com/');
    expect(sources[0]?.src).toBe('https://fonts.example.com/Anton.ttf');
  });

  it('returns an empty array for no families', () => {
    expect(fontSources([], 'https://fonts.example.com')).toEqual([]);
  });
});
