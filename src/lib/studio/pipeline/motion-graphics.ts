import { escapeHtml, HEX_COLOUR, roundSec } from './edl-time';

// BACKLOG 15.B8 — MOTION_GRAPHICS shots (spec 4.5 "MOTION_GFX → Shotstack template", spec 5.3
// enum). Rendered by the composer itself, no provider call: a brand-coloured background, an
// animated accent bar and the shot's text. Built only from documented Shotstack assets and clip
// properties (https://shotstack.io/docs/api/, read 2026-09-28):
//   - ShapeAsset { type: 'shape', shape: 'rectangle', width, height, fill { color, opacity },
//     rectangle { width, height, cornerRadius } };
//   - HtmlAsset { type: 'html', html, css, width, height, position } (the same asset the text
//     cards use);
//   - Clip `transition` in/out names (fade, slideUp, carouselLeft, carouselRight, …), `position`
//     and `offset` (y positive upwards).
// Three clips per shot: background (visual track), accent bar and text (their own tracks, as
// Shotstack forbids overlapping clips on one track).

export interface MotionPalette {
  background: string;
  text: string;
  accent: string;
}

export function motionPalette(colours: string[]): MotionPalette {
  const valid = colours.filter((c) => HEX_COLOUR.test(c));
  const background = valid[0] ?? '#111111';
  const text = valid[1] ?? '#ffffff';
  return { background, text, accent: valid[2] ?? text };
}

export interface MotionCardInput {
  startSec: number;
  lengthSec: number;
  text: string;
  frame: { width: number; height: number };
  palette: MotionPalette;
  /** css font-family value (already validated). */
  fontFamily: string;
  /** Right-to-left text (Arabic): HTML `dir="rtl"`. */
  rtl?: boolean;
  /** The shot's out transition (TRANSITION_MAP value), applied to the background. */
  transitionOut?: string;
}

export interface MotionCardClips {
  background: Record<string, unknown>;
  accent: Record<string, unknown>;
  text: Record<string, unknown>;
}

export function motionCardClips(input: MotionCardInput): MotionCardClips {
  const { width, height } = input.frame;
  const start = roundSec(input.startSec);
  const length = roundSec(input.lengthSec);
  const barWidth = Math.round(width * 0.6);
  const barHeight = Math.max(4, Math.round(height * 0.012));
  const fontPx = Math.round(height * 0.055);
  return {
    background: {
      asset: {
        type: 'shape',
        shape: 'rectangle',
        width,
        height,
        fill: { color: input.palette.background, opacity: 1 },
        rectangle: { width, height },
      },
      start,
      length,
      transition: {
        in: 'fade',
        ...(input.transitionOut && { out: input.transitionOut }),
      },
    },
    accent: {
      asset: {
        type: 'shape',
        shape: 'rectangle',
        width: barWidth,
        height: barHeight,
        fill: { color: input.palette.accent, opacity: 1 },
        rectangle: { width: barWidth, height: barHeight, cornerRadius: Math.round(barHeight / 2) },
      },
      start,
      length,
      position: 'center',
      offset: { x: 0, y: -0.09 },
      transition: { in: 'carouselLeft', out: 'carouselRight' },
    },
    text: {
      asset: {
        type: 'html',
        html: `<p${input.rtl ? ' dir="rtl"' : ''}>${escapeHtml(input.text)}</p>`,
        css: `p { font-family: '${input.fontFamily}', sans-serif; color: ${input.palette.text}; font-size: ${fontPx}px; font-weight: 800; text-align: center; margin: 0; }`,
        width: Math.round(width * 0.84),
        height: Math.round(height * 0.3),
        position: 'center',
      },
      start,
      length,
      position: 'center',
      transition: { in: 'slideUp', out: 'fade' },
    },
  };
}
