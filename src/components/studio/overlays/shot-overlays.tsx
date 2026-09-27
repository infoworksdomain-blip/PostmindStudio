'use client';

import { OverlaySet } from './overlay-set';
import { MAX_OVERLAYS_PER_SHOT, type Overlay, type OverlayPreset } from './types';

// One shot's overlays (A4.1) — the shared overlay set (overlay-set.tsx) bound to
// /shots/:id/overlays.

export function ShotOverlays({
  shotId,
  duration,
  aspectRatio,
  platform,
  editable,
  presets,
  businessId,
  onPresetsChanged,
}: {
  shotId: string;
  duration: number;
  aspectRatio: string;
  platform?: string;
  editable: boolean;
  presets: OverlayPreset[];
  businessId: string | null;
  onPresetsChanged: () => void;
}) {
  return (
    <OverlaySet
      listPath={`/shots/${shotId}/overlays`}
      create={({ presetId, ...rest }) => ({
        path: `/shots/${shotId}/overlays`,
        body: { ...rest, ...(presetId && { presetId }) },
        pick: (res) => (res as { overlay?: Overlay }).overlay?.id ?? null,
      })}
      maxCount={MAX_OVERLAYS_PER_SHOT}
      duration={duration}
      aspectRatio={aspectRatio}
      platform={platform}
      editable={editable}
      presets={presets}
      businessId={businessId}
      onPresetsChanged={onPresetsChanged}
    />
  );
}
