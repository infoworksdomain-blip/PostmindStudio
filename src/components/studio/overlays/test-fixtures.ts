import type { Overlay, OverlayPreset } from './types';

// Test fixtures for the overlay editor (a text_overlays row with DEFAULT_STYLE values).

export function makeOverlay(over: Partial<Overlay> = {}): Overlay {
  return {
    id: 'ov_1',
    shotId: 'shot_1',
    renderId: null,
    presetId: null,
    sortOrder: 0,
    text: 'Wait for it',
    lang: 'en-GB',
    startAtSec: 0.5,
    endAtSec: 2.5,
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
    ...over,
  };
}

export const PRESETS: OverlayPreset[] = [
  {
    id: 'pre_hook',
    scope: 'BUILT_IN',
    organisationId: null,
    businessId: null,
    name: 'Bold hook',
    group: 'hook',
    parameters: { fontSizePct: 8 },
    brandSubstitution: true,
  },
  {
    id: 'pre_cta',
    scope: 'BUSINESS',
    organisationId: 'org_1',
    businessId: 'biz_1',
    name: 'Our CTA',
    group: 'cta',
    parameters: {},
    brandSubstitution: true,
  },
];
