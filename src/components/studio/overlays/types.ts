// Overlay editor shapes (prisma TextOverlay / OverlayPreset rows as JSON) and the vocabularies of
// lib/studio/overlays/params.ts, repeated here because the UI never imports server modules.

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

export const BACKGROUND_TYPES = ['none', 'box', 'rounded_box', 'gradient', 'blur'] as const;
export const ALIGNMENTS = ['left', 'center', 'right'] as const;
export const PRESET_GROUPS = [
  'hook',
  'subtitle',
  'cta',
  'quote',
  'statistic',
  'story',
  'brand',
] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

/** Style fields the editor exposes (a subset of overlayStyle; the rest keep their values). */
export interface EditableStyle {
  animationIn: string;
  animationOut: string;
  fontFamily: string;
  fontWeight: number;
  fontSizePct: number;
  fontItalic: boolean;
  fillColor: string;
  strokeColor: string | null;
  strokeWidthPx: number | null;
  shadowColor: string | null;
  shadowBlurPx: number | null;
  backgroundType: string;
  backgroundColor: string | null;
  backgroundPaddingPx: number | null;
  backgroundRadiusPx: number | null;
  anchorX: number;
  anchorY: number;
  alignment: string;
  rotationDeg: number;
}

export const STYLE_KEYS: Array<keyof EditableStyle> = [
  'animationIn',
  'animationOut',
  'fontFamily',
  'fontWeight',
  'fontSizePct',
  'fontItalic',
  'fillColor',
  'strokeColor',
  'strokeWidthPx',
  'shadowColor',
  'shadowBlurPx',
  'backgroundType',
  'backgroundColor',
  'backgroundPaddingPx',
  'backgroundRadiusPx',
  'anchorX',
  'anchorY',
  'alignment',
  'rotationDeg',
];

export interface Overlay extends EditableStyle {
  id: string;
  shotId: string | null;
  renderId: string | null;
  presetId: string | null;
  sortOrder: number;
  text: string;
  lang: string;
  startAtSec: number;
  endAtSec: number;
  animationInMs: number;
  animationOutMs: number;
  easing: string;
  letterSpacing: number | null;
  lineHeight: number | null;
  shadowOffsetXPx: number | null;
  shadowOffsetYPx: number | null;
  effect: Record<string, number> | null;
}

/** What the editor can change locally before saving. */
export type OverlayDraft = Partial<
  Pick<Overlay, 'text' | 'startAtSec' | 'endAtSec'> & EditableStyle
>;

export interface OverlayPreset {
  id: string;
  scope: 'BUILT_IN' | 'ORG' | 'BUSINESS';
  organisationId: string | null;
  businessId: string | null;
  name: string;
  group: string;
  parameters: Partial<EditableStyle> & Record<string, unknown>;
  brandSubstitution: boolean;
}

export interface OverlayPreviewResult {
  preview: { url: string; expiresInSec: number; range: { start: number; length: number } };
}

/** Project states in which overlays can be created, edited or deleted. */
export const OVERLAY_EDITABLE = new Set([
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
]);
/** POST /renders/:id/rerender accepts these. */
export const RERENDERABLE = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'REJECTED']);
export const MAX_OVERLAYS_PER_SHOT = 12;

export const ANIMATION_LABEL = (a: string): string =>
  a === 'none' ? 'None' : a.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
