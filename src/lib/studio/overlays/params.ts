import { z } from 'zod';

// BACKLOG 8.1 / Addendum A4.2 + A4.4 — overlay parameters. One schema shared by overlays
// (text + timing + style) and presets (style only), mirroring the text_overlays columns.

export const ANIMATIONS = [
  'none',
  'fadeIn',
  'fadeOut',
  'slideInLeft',
  'slideInRight',
  'slideInTop',
  'slideInBottom',
  'slideOutLeft',
  'slideOutRight',
  'slideOutTop',
  'slideOutBottom',
  'scaleIn',
  'scaleOut',
  'typewriter',
  'popIn',
  'wave',
  'glitch',
  'blurIn',
  'karaokeHighlight',
  'counter',
] as const;
export type Animation = (typeof ANIMATIONS)[number];

/** A4.6: animations the composer cannot do natively; pre-rendered with FFmpeg (BACKLOG 8.4). */
export const PRE_RENDERED_ANIMATIONS: ReadonlySet<Animation> = new Set([
  'glitch',
  'karaokeHighlight',
  'counter',
]);

export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const;
export const BACKGROUND_TYPES = ['none', 'box', 'rounded_box', 'gradient', 'blur'] as const;
export const ALIGNMENTS = ['left', 'center', 'right'] as const;

/** #RRGGBB or #RRGGBBAA. */
const colour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'colour must be #RRGGBB or #RRGGBBAA');
/** Google Fonts style family names only: letters, digits, spaces, hyphens. */
const fontFamily = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9 -]{1,64}$/, 'invalid font family');

export const overlayStyle = z
  .object({
    animationIn: z.enum(ANIMATIONS),
    animationOut: z.enum(ANIMATIONS),
    animationInMs: z.number().int().min(0).max(5_000),
    animationOutMs: z.number().int().min(0).max(5_000),
    easing: z.enum(EASINGS),
    fontFamily,
    fontWeight: z.number().int().min(100).max(900).multipleOf(100),
    fontSizePct: z.number().min(1).max(40),
    fontItalic: z.boolean(),
    letterSpacing: z.number().min(-20).max(50).nullable(),
    lineHeight: z.number().min(0.5).max(3).nullable(),
    fillColor: colour,
    strokeColor: colour.nullable(),
    strokeWidthPx: z.number().min(0).max(20).nullable(),
    shadowColor: colour.nullable(),
    shadowBlurPx: z.number().min(0).max(50).nullable(),
    shadowOffsetXPx: z.number().min(-50).max(50).nullable(),
    shadowOffsetYPx: z.number().min(-50).max(50).nullable(),
    backgroundType: z.enum(BACKGROUND_TYPES),
    backgroundColor: colour.nullable(),
    backgroundPaddingPx: z.number().min(0).max(200).nullable(),
    /** Large values (e.g. 999) make a pill shape. */
    backgroundRadiusPx: z.number().min(0).max(1_000).nullable(),
    anchorX: z.number().min(0).max(1),
    anchorY: z.number().min(0).max(1),
    alignment: z.enum(ALIGNMENTS),
    rotationDeg: z.number().min(-180).max(180),
    /** typewriterCPS, waveAmplitude, glitchIntensity, counter {from,to} … (A4.2 Effects). */
    effect: z
      .object({
        typewriterCPS: z.number().min(1).max(100).optional(),
        waveAmplitude: z.number().min(0).max(1).optional(),
        glitchIntensity: z.number().min(0).max(1).optional(),
        counterFrom: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
        counterTo: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type OverlayStyle = z.infer<typeof overlayStyle>;

/** Same fields, but ignores other keys: for reading the style out of a text_overlays row. */
export const overlayStyleFromRow = z.object(overlayStyle.shape);

export const DEFAULT_STYLE: OverlayStyle = {
  animationIn: 'fadeIn',
  animationOut: 'fadeOut',
  animationInMs: 400,
  animationOutMs: 400,
  easing: 'easeInOut',
  fontFamily: 'Montserrat',
  fontWeight: 700,
  fontSizePct: 5,
  fontItalic: false,
  letterSpacing: null,
  lineHeight: null,
  fillColor: '#FFFFFF',
  strokeColor: null,
  strokeWidthPx: null,
  shadowColor: '#00000080',
  shadowBlurPx: 6,
  shadowOffsetXPx: 0,
  shadowOffsetYPx: 2,
  backgroundType: 'none',
  backgroundColor: null,
  backgroundPaddingPx: null,
  backgroundRadiusPx: null,
  anchorX: 0.5,
  anchorY: 0.5,
  alignment: 'center',
  rotationDeg: 0,
  effect: null,
};

export const overlayTiming = z
  .object({
    startAtSec: z.number().min(0).max(3_600),
    endAtSec: z.number().min(0).max(3_600),
  })
  .refine((t) => t.endAtSec > t.startAtSec, { message: 'endAtSec must be after startAtSec' });

export const overlayText = z.object({
  text: z.string().trim().min(1).max(500),
  lang: z
    .string()
    .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, 'lang must be a BCP 47 tag')
    .optional(),
});

/** Preset parameters are a partial style: anything unset falls back to DEFAULT_STYLE. */
export const presetParameters = overlayStyle.partial();
export type PresetParameters = z.infer<typeof presetParameters>;

export function resolveStyle(...layers: Array<PresetParameters | null | undefined>): OverlayStyle {
  return Object.assign({}, DEFAULT_STYLE, ...layers.filter(Boolean)) as OverlayStyle;
}

/** A4.3 brand-kit substitution: the preset's shape stays; palette and font follow the brand. */
export function applyBrand(
  style: OverlayStyle,
  brand: { primary?: string; secondary?: string; fontFamily?: string } | null,
): OverlayStyle {
  if (!brand) return style;
  const ok = (c?: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : undefined);
  const primary = ok(brand.primary);
  const secondary = ok(brand.secondary);
  const font =
    brand.fontFamily && /^[A-Za-z0-9 -]{1,64}$/.test(brand.fontFamily)
      ? brand.fontFamily
      : undefined;
  return {
    ...style,
    ...(font && { fontFamily: font }),
    ...(secondary && { fillColor: secondary }),
    ...(primary && style.backgroundType !== 'none' && { backgroundColor: primary }),
    ...(primary && style.strokeColor && { strokeColor: primary }),
  };
}
