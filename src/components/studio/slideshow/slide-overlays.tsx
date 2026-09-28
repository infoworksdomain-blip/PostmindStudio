'use client';

import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { OverlaySet } from '../overlays/overlay-set';
import type { Overlay, OverlayPreset } from '../overlays/types';

// 13.4 — a slide's text overlays (GET|POST /slides/:id/overlays), edited with the same overlay
// set as shots. Timing is relative to the slide; an image slide's styled overlays replace its
// plain caption in the render.

export const MAX_OVERLAYS_PER_SLIDE = 12;

export function SlideOverlays({
  slideId,
  duration,
  aspectRatio,
  platform,
  editable,
  businessId,
}: {
  slideId: string;
  duration: number;
  aspectRatio: string;
  platform?: string;
  editable: boolean;
  businessId: string | null;
}) {
  const t = useTranslations('slideshow.overlays');
  const presets = useApi<{ data: OverlayPreset[] }>('/overlay-presets', {
    businessId: businessId ?? undefined,
  });
  return (
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{t('summary')}</summary>
      <div className="pt-3">
        <OverlaySet
          listPath={`/slides/${slideId}/overlays`}
          create={({ presetId, ...rest }) => ({
            path: `/slides/${slideId}/overlays`,
            body: { ...rest, ...(presetId && { presetId }) },
            pick: (res) => (res as { overlay?: Overlay }).overlay?.id ?? null,
          })}
          maxCount={MAX_OVERLAYS_PER_SLIDE}
          duration={duration}
          aspectRatio={aspectRatio}
          platform={platform}
          editable={editable}
          presets={presets.data?.data ?? []}
          businessId={businessId}
          onPresetsChanged={() => void presets.mutate()}
          canPreview={false}
          unit="slide"
        />
      </div>
    </details>
  );
}
