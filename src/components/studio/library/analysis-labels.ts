'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { humanise } from './library-utils';

// Labels for the closed analysis vocabularies (src/lib/studio/library/analyse.ts: PACE_TAGS,
// SHOT_TYPES, OVERLAY_STYLES) from `library.analysis`. A value outside the vocabulary (older
// analyses) falls back to the humanised raw value.

const PACE_KEY = { slow: 'slow', medium: 'medium', 'fast-cut': 'fastCut' } as const;

const SHOT_KEY = {
  HOOK_TEXT_ON_STILL: 'hookTextOnStill',
  TALKING_HEAD: 'talkingHead',
  AVATAR_TALKING: 'avatarTalking',
  AI_CLIP_ACTION: 'aiClipAction',
  PRODUCT_SHOT: 'productShot',
  STOCK_LIFESTYLE: 'stockLifestyle',
  SCREEN_RECORDING: 'screenRecording',
  B_ROLL: 'bRoll',
  TEXT_CARD: 'textCard',
  CTA_CARD: 'ctaCard',
} as const;

const OVERLAY_KEY = {
  none: 'none',
  'bold-centre': 'boldCentre',
  'bold-top': 'boldTop',
  'bold-bottom': 'boldBottom',
  'subtitle-lower': 'subtitleLower',
  'caption-box': 'captionBox',
  quote: 'quote',
  'big-number': 'bigNumber',
} as const;

function lookup<T extends Record<string, string>>(
  map: T,
  value: string | null | undefined,
): T[keyof T] | undefined {
  return value && Object.prototype.hasOwnProperty.call(map, value)
    ? map[value as keyof T]
    : undefined;
}

export interface AnalysisLabels {
  pace: (value: string | null | undefined) => string;
  shotType: (value: string | null | undefined) => string;
  overlay: (value: string | null | undefined) => string;
}

export function useAnalysisLabels(): AnalysisLabels {
  const t = useTranslations('library.analysis');
  return useMemo<AnalysisLabels>(
    () => ({
      pace: (value) => {
        const key = lookup(PACE_KEY, value);
        return key ? t(`pace.${key}`) : humanise(value);
      },
      shotType: (value) => {
        const key = lookup(SHOT_KEY, value);
        return key ? t(`shotType.${key}`) : humanise(value);
      },
      overlay: (value) => {
        const key = lookup(OVERLAY_KEY, value);
        return key ? t(`overlay.${key}`) : humanise(value);
      },
    }),
    [t],
  );
}
