import { roundSec } from '../pipeline/edl';
import { PRE_RENDERED_ANIMATIONS, type Animation, type OverlayStyle } from './params';

// BACKLOG 8.3 / Addendum A4.6 — TextOverlay → Shotstack clip. A4.6 sketches the `text` asset,
// but Shotstack's API reference (read 2026-09-27) marks `text` and `html` deprecated in favour
// of `rich-text`, which also supports shadows; this translator emits `rich-text`. Only
// documented fields are used: rich-text font/style/stroke/shadow/background/align/animation;
// clip start/length/width/height/position/offset/transform.rotate/transition/opacity/scale
// (Tween arrays for scale/offset where noted). Offsets are relative to the viewport, y up.
//
// Animations Shotstack cannot express (glitch, karaokeHighlight, counter) are pre-rendered to
// a transparent MOV (BACKLOG 8.4) and placed as a video clip instead — see prerender.ts.

export interface OverlayRow extends OverlayStyle {
  id: string;
  text: string;
  startAtSec: number;
  endAtSec: number;
  /** Karaoke (13.6): highlight time per word, seconds from the overlay start (spoken timing). */
  wordStartsSec?: number[];
}

export interface FrameSize {
  width: number;
  height: number;
}

const FAST_MS = 300;
const SLOW_MS = 800;

/** Clip transition name with Shotstack's speed variants chosen from the duration. */
function speed(name: string, ms: number): string {
  if (ms <= FAST_MS) return `${name}Fast`;
  if (ms >= SLOW_MS) return `${name}Slow`;
  return name;
}

/**
 * Overlay animation → clip transition. Shotstack slide transitions are named for the direction
 * of travel, so an overlay entering from the left travels right ("slideRight").
 */
const TRANSITION_IN: Partial<Record<Animation, string>> = {
  fadeIn: 'fade',
  blurIn: 'fade', // approximation: no blur tween in the documented clip properties
  slideInLeft: 'slideRight',
  slideInRight: 'slideLeft',
  slideInTop: 'slideDown',
  slideInBottom: 'slideUp',
};
const TRANSITION_OUT: Partial<Record<Animation, string>> = {
  fadeOut: 'fade',
  slideOutLeft: 'slideLeft',
  slideOutRight: 'slideRight',
  slideOutTop: 'slideUp',
  slideOutBottom: 'slideDown',
};

/** #RRGGBBAA → { color: #RRGGBB, opacity } */
export function splitColour(hex: string): { color: string; opacity: number } {
  const color = hex.slice(0, 7).toLowerCase();
  const alpha = hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1;
  return { color, opacity: Math.round(alpha * 1000) / 1000 };
}

export function fontPx(style: Pick<OverlayStyle, 'fontSizePct'>, frame: FrameSize): number {
  return Math.max(1, Math.min(500, Math.round((style.fontSizePct / 100) * frame.height)));
}

function richTextAsset(overlay: OverlayRow, frame: FrameSize): Record<string, unknown> {
  const fill = splitColour(overlay.fillColor);
  const asset: Record<string, unknown> = {
    type: 'rich-text',
    text: overlay.text.slice(0, 5_000),
    font: {
      family: overlay.fontFamily,
      size: fontPx(overlay, frame),
      weight: overlay.fontWeight,
      style: overlay.fontItalic ? 'italic' : 'normal',
      color: fill.color,
      opacity: fill.opacity,
    },
    align: { horizontal: overlay.alignment, vertical: 'middle' },
  };
  const style: Record<string, number> = {};
  if (overlay.letterSpacing !== null) style.letterSpacing = overlay.letterSpacing;
  if (overlay.lineHeight !== null) style.lineHeight = overlay.lineHeight;
  if (Object.keys(style).length) asset.style = style;
  if (overlay.strokeColor && overlay.strokeWidthPx) {
    asset.stroke = { width: overlay.strokeWidthPx, ...splitColour(overlay.strokeColor) };
  }
  if (overlay.shadowColor) {
    asset.shadow = {
      offsetX: overlay.shadowOffsetXPx ?? 0,
      offsetY: overlay.shadowOffsetYPx ?? 0,
      blur: overlay.shadowBlurPx ?? 0,
      ...splitColour(overlay.shadowColor),
    };
  }
  if (overlay.backgroundType !== 'none' && overlay.backgroundColor) {
    asset.background = {
      ...splitColour(overlay.backgroundColor),
      borderRadius:
        overlay.backgroundType === 'rounded_box' ? (overlay.backgroundRadiusPx ?? 12) : 0,
      wrap: true,
      padding: Math.round(overlay.backgroundPaddingPx ?? 8),
    };
  }
  if (overlay.animationIn === 'typewriter') {
    const cps = overlay.effect?.typewriterCPS ?? 15;
    const length = overlay.endAtSec - overlay.startAtSec;
    asset.animation = {
      preset: 'typewriter',
      style: 'character',
      duration: Math.min(30, Math.max(0.1, Math.min(length, overlay.text.length / cps))),
    };
  }
  return asset;
}

/** Scale-in (optionally with an overshoot for popIn) as a documented Tween array. */
function scaleTweens(overlay: OverlayRow): Record<string, unknown>[] | undefined {
  if (overlay.animationIn !== 'scaleIn' && overlay.animationIn !== 'popIn') return undefined;
  const length = Math.max(0.1, overlay.animationInMs / 1000);
  return [
    {
      from: 0,
      to: 1,
      start: 0,
      length,
      interpolation: 'bezier',
      easing: overlay.animationIn === 'popIn' ? 'easeOutBack' : 'easeOut',
    },
  ];
}

/** Gentle vertical bob through the hold phase (A4.4 "wave"). */
function waveTweens(overlay: OverlayRow, baseY: number): Record<string, unknown>[] | undefined {
  if (overlay.animationIn !== 'wave') return undefined;
  const amplitude = (overlay.effect?.waveAmplitude ?? 0.3) * 0.02;
  const length = overlay.endAtSec - overlay.startAtSec;
  const period = 0.6;
  const tweens: Record<string, unknown>[] = [];
  for (let t = 0, up = true; t < length; t += period / 2, up = !up) {
    tweens.push({
      from: roundSec(baseY + (up ? -amplitude : amplitude)),
      to: roundSec(baseY + (up ? amplitude : -amplitude)),
      start: roundSec(t),
      length: roundSec(Math.min(period / 2, length - t)),
      interpolation: 'bezier',
      easing: 'easeInOutSine',
    });
  }
  return tweens;
}

export function overlayClip(
  overlay: OverlayRow,
  input: { frame: FrameSize; offsetSec: number },
): Record<string, unknown> {
  const x = roundSec(overlay.anchorX - 0.5);
  const y = roundSec(0.5 - overlay.anchorY); // Shotstack offset.y is positive upwards
  const start = roundSec(input.offsetSec + overlay.startAtSec);
  const length = roundSec(overlay.endAtSec - overlay.startAtSec);
  const transitionIn = TRANSITION_IN[overlay.animationIn];
  const transitionOut = TRANSITION_OUT[overlay.animationOut];
  const wave = waveTweens(overlay, y);
  const scale = scaleTweens(overlay);
  return {
    asset: richTextAsset(overlay, input.frame),
    start,
    length,
    width: Math.round(input.frame.width * 0.9),
    height: Math.round(Math.min(input.frame.height, fontPx(overlay, input.frame) * 4 + 40)),
    position: 'center',
    offset: { x, y: wave ?? y },
    ...(overlay.rotationDeg !== 0 && { transform: { rotate: { angle: overlay.rotationDeg } } }),
    ...(scale && { scale }),
    ...((transitionIn || transitionOut) && {
      transition: {
        ...(transitionIn && { in: speed(transitionIn, overlay.animationInMs) }),
        ...(transitionOut && { out: speed(transitionOut, overlay.animationOutMs) }),
      },
    }),
  };
}

export function needsPreRender(
  overlay: Pick<OverlayStyle, 'animationIn' | 'animationOut'>,
): boolean {
  return (
    PRE_RENDERED_ANIMATIONS.has(overlay.animationIn) ||
    PRE_RENDERED_ANIMATIONS.has(overlay.animationOut)
  );
}

/** A pre-rendered (transparent MOV) overlay placed over the video. */
export function preRenderedClip(
  overlay: Pick<OverlayRow, 'startAtSec' | 'endAtSec'>,
  input: { src: string; offsetSec: number },
): Record<string, unknown> {
  return {
    asset: { type: 'video', src: input.src, volume: 0 },
    start: roundSec(input.offsetSec + overlay.startAtSec),
    length: roundSec(overlay.endAtSec - overlay.startAtSec),
    fit: 'none',
    position: 'center',
  };
}

/** timeline.fonts entries for the families used (fonts are not pre-installed on Shotstack). */
export function fontSources(families: Iterable<string>, baseUrl: string): Array<{ src: string }> {
  const base = baseUrl.replace(/\/$/, '');
  return [...new Set(families)].sort().map((family) => ({
    src: `${base}/${encodeURIComponent(family.replace(/ /g, ''))}.ttf`,
  }));
}
