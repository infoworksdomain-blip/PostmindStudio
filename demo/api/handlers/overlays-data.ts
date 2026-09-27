// Overlay editor sample data: presets across every group (built-in, organisation, business) and
// per-shot overlays. A shot's overlays are seeded from its on-screen text the first time the
// editor opens it, so every generated shot has something to style.
import type { EditableStyle, Overlay, OverlayPreset } from '@/components/studio/overlays/types';
import { DEMO_BUSINESS_ID, DEMO_ORG_ID } from '../ids';
import type { ShotRec } from './projects-store';

type Style = EditableStyle &
  Pick<
    Overlay,
    | 'animationInMs'
    | 'animationOutMs'
    | 'easing'
    | 'letterSpacing'
    | 'lineHeight'
    | 'shadowOffsetXPx'
    | 'shadowOffsetYPx'
    | 'effect'
  >;

export const DEFAULT_STYLE: Style = {
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

const preset = (
  id: string,
  name: string,
  group: string,
  parameters: OverlayPreset['parameters'],
  scope: OverlayPreset['scope'] = 'BUILT_IN',
): OverlayPreset => ({
  id,
  scope,
  organisationId: scope === 'BUILT_IN' ? null : DEMO_ORG_ID,
  businessId: scope === 'BUSINESS' ? DEMO_BUSINESS_ID : null,
  name,
  group,
  parameters,
  brandSubstitution: scope !== 'BUILT_IN',
});

export const presets: OverlayPreset[] = [
  preset('ovp-bold-hook', 'Bold hook', 'hook', {
    fontSizePct: 8,
    fontWeight: 900,
    animationIn: 'popIn',
    anchorY: 0.22,
    strokeColor: '#000000',
    strokeWidthPx: 4,
  }),
  preset('ovp-typewriter-hook', 'Typewriter hook', 'hook', {
    animationIn: 'typewriter',
    fontFamily: 'Space Mono',
    fontSizePct: 6,
    backgroundType: 'box',
    backgroundColor: '#000000CC',
    backgroundPaddingPx: 16,
    anchorY: 0.2,
  }),
  preset('ovp-karaoke', 'Karaoke subtitles', 'subtitle', {
    animationIn: 'karaokeHighlight',
    fontSizePct: 4.5,
    anchorY: 0.78,
    fillColor: '#FFE14D',
  }),
  preset('ovp-clean-sub', 'Clean subtitles', 'subtitle', {
    fontWeight: 600,
    fontSizePct: 4,
    anchorY: 0.82,
    backgroundType: 'rounded_box',
    backgroundColor: '#00000099',
    backgroundPaddingPx: 10,
    backgroundRadiusPx: 12,
  }),
  preset('ovp-cta-pill', 'CTA pill', 'cta', {
    backgroundType: 'rounded_box',
    backgroundColor: '#E2552F',
    backgroundPaddingPx: 18,
    backgroundRadiusPx: 40,
    animationIn: 'slideInBottom',
    anchorY: 0.85,
  }),
  preset('ovp-pull-quote', 'Pull quote', 'quote', {
    fontFamily: 'Playfair Display',
    fontItalic: true,
    fontWeight: 600,
    fontSizePct: 6,
    animationIn: 'blurIn',
  }),
  preset('ovp-big-number', 'Big number', 'statistic', {
    fontSizePct: 14,
    fontWeight: 900,
    animationIn: 'counter',
    fillColor: '#FFE14D',
  }),
  preset('ovp-chapter', 'Chapter title', 'story', {
    fontFamily: 'Playfair Display',
    fontSizePct: 7,
    animationIn: 'slideInLeft',
    alignment: 'left',
    anchorX: 0.1,
    anchorY: 0.15,
  }),
  preset(
    'ovp-org-handle',
    'Leeds Sourdough handle',
    'brand',
    {
      fontSizePct: 3.5,
      fontWeight: 700,
      anchorX: 0.85,
      anchorY: 0.92,
      alignment: 'right',
      animationIn: 'none',
      animationOut: 'none',
      fillColor: '#FBF6EE',
    },
    'ORG',
  ),
  preset(
    'ovp-biz-price',
    'Price tag (terracotta)',
    'cta',
    {
      backgroundType: 'box',
      backgroundColor: '#C2452D',
      fontFamily: 'Fraunces',
      fontSizePct: 6,
      rotationDeg: -4,
      anchorX: 0.72,
      anchorY: 0.3,
      animationIn: 'popIn',
    },
    'BUSINESS',
  ),
  preset(
    'ovp-biz-hook',
    'Warm hook (brand kit)',
    'hook',
    {
      fontFamily: 'Fraunces',
      fontSizePct: 7.5,
      fillColor: '#FBF6EE',
      shadowColor: '#3B2112CC',
      shadowBlurPx: 12,
      anchorY: 0.2,
    },
    'BUSINESS',
  ),
];

/** The style an overlay gets from a preset plus explicit overrides. */
/** Only the known style keys of an untrusted parameters object. */
export function styleKeys(v: Record<string, unknown>): Partial<Style> {
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => k in DEFAULT_STYLE),
  ) as Partial<Style>;
}

export function resolveStyle(
  presetId: string | null,
  overrides: Record<string, unknown> = {},
): Style {
  const p = presets.find((x) => x.id === presetId);
  return { ...DEFAULT_STYLE, ...styleKeys(p?.parameters ?? {}), ...styleKeys(overrides) };
}

let seq = 0;
export function makeOverlay(
  target: { shotId: string | null; renderId: string | null },
  input: {
    text: string;
    startAtSec: number;
    endAtSec: number;
    presetId?: string | null;
    style?: Record<string, unknown>;
    sortOrder?: number;
  },
): Overlay {
  seq += 1;
  return {
    id: `ovl-${Date.now().toString(36)}${seq}`,
    shotId: target.shotId,
    renderId: target.renderId,
    presetId: input.presetId ?? null,
    sortOrder: input.sortOrder ?? 0,
    text: input.text,
    lang: 'en-GB',
    startAtSec: input.startAtSec,
    endAtSec: input.endAtSec,
    ...resolveStyle(input.presetId ?? null, input.style),
  };
}

export const shotOverlays = new Map<string, Overlay[]>();
export const videoOverlays = new Map<string, Overlay[]>();

/** Overlays of a shot, seeded from its on-screen text on first use. */
export function overlaysFor(shot: ShotRec, index: number): Overlay[] {
  let list = shotOverlays.get(shot.id);
  if (!list) {
    list = [];
    const end = Math.round(shot.durationSec * 10) / 10;
    if (shot.onScreenText)
      list.push(
        makeOverlay(
          { shotId: shot.id, renderId: null },
          {
            text: shot.onScreenText,
            startAtSec: 0.3,
            endAtSec: Math.max(1, end - 0.3),
            presetId:
              index === 0
                ? 'ovp-bold-hook'
                : shot.visualTreatment === 'TEXT_CARD'
                  ? 'ovp-cta-pill'
                  : 'ovp-clean-sub',
          },
        ),
      );
    if (index === 0)
      list.push(
        makeOverlay(
          { shotId: shot.id, renderId: null },
          {
            text: '@leedssourdough',
            startAtSec: 0,
            endAtSec: end,
            presetId: 'ovp-org-handle',
            sortOrder: 1,
          },
        ),
      );
    shotOverlays.set(shot.id, list);
  }
  return list;
}

export function findOverlay(
  id: string,
): { list: Overlay[]; overlay: Overlay; key: string; kind: 'shot' | 'video' } | null {
  for (const [kind, map] of [
    ['shot', shotOverlays],
    ['video', videoOverlays],
  ] as const)
    for (const [key, list] of map) {
      const overlay = list.find((o) => o.id === id);
      if (overlay) return { list, overlay, key, kind };
    }
  return null;
}
