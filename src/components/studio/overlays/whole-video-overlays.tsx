'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { Field, NativeSelect } from '../review/field';
import { OverlaySet } from './overlay-set';
import type { Overlay, OverlayPreset } from './types';

// 13.3 — the "Whole video" lane: overlays that span a whole render (watermarks, handles), listed
// with GET /renders/:id/overlays (all whole-video overlays composition applies to that platform)
// and added with POST /renders/:id/overlays/bulk. Timing is relative to the whole video.

export const MAX_WHOLE_VIDEO_OVERLAYS = 6;

export function WholeVideoOverlays({
  project,
  editable,
  presets,
  businessId,
  onPresetsChanged,
}: {
  project: ProjectDetail;
  editable: boolean;
  presets: OverlayPreset[];
  businessId: string | null;
  onPresetsChanged: () => void;
}) {
  const t = useTranslations('overlays.wholeVideo');
  const f = useFormat();
  // Newest render per platform: that is what a re-render replaces.
  const latest = [...project.renders]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((r, i, all) => all.findIndex((x) => x.targetPlatform === r.targetPlatform) === i);
  const [renderId, setRenderId] = useState(latest[0]?.id ?? '');
  const render = latest.find((r) => r.id === renderId) ?? latest[0];

  if (!render) return <p className="text-sm text-muted-foreground">{t('none')}</p>;

  return (
    <div className="flex flex-col gap-4">
      {latest.length > 1 && (
        <Field id="whole-video-render" label={t('variant')} className="w-full sm:w-64">
          <NativeSelect
            id="whole-video-render"
            value={render.id}
            onChange={(e) => setRenderId(e.target.value)}
          >
            {latest.map((r) => (
              <option key={r.id} value={r.id}>
                {t('variantOption', {
                  platform: f.platform(r.targetPlatform),
                  ratio: r.aspectRatio,
                })}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <OverlaySet
        key={render.id}
        listPath={`/renders/${render.id}/overlays`}
        create={({ presetId, ...rest }) => ({
          path: `/renders/${render.id}/overlays/bulk`,
          body: { overlay: { ...rest, ...(presetId && { presetId }) } },
          pick: (res) => (res as { data?: Overlay[] }).data?.[0]?.id ?? null,
        })}
        maxCount={MAX_WHOLE_VIDEO_OVERLAYS}
        duration={render.durationSec}
        aspectRatio={render.aspectRatio}
        platform={render.targetPlatform}
        editable={editable}
        presets={presets}
        businessId={businessId}
        onPresetsChanged={onPresetsChanged}
        canPreview={false}
        unit="video"
      />
    </div>
  );
}
