'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { ErrorState, Section } from '../primitives';
import { ScriptSelect } from '../review/shots-tab';
import { ShotStrip } from '../review/shot-strip';
import { BulkApply } from './bulk-apply';
import { ShotOverlays } from './shot-overlays';
import { WholeVideoOverlays } from './whole-video-overlays';
import { OVERLAY_EDITABLE, type OverlayPreset } from './types';

// BACKLOG 10.10 — overlay editor (Addendum A4): pick a variant and a shot, then add, style and
// time its overlays; a "Whole video" lane for render-wide overlays (13.3); bulk-apply across
// the video; re-render with the current overlays.

export function OverlayEditor({
  project,
  businessId,
  onChanged,
}: {
  project: ProjectDetail;
  businessId: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations('overlays.editor');
  const f = useFormat();
  const [scriptId, setScriptId] = useState(project.scripts[0]?.id ?? '');
  const [shotId, setShotId] = useState<string | null>(project.scripts[0]?.shots[0]?.id ?? null);
  const presets = useApi<{ data: OverlayPreset[] }>('/overlay-presets', {
    businessId: businessId ?? undefined,
  });
  const { mutate: mutateCache } = useSWRConfig();
  const script = project.scripts.find((s) => s.id === scriptId) ?? project.scripts[0];
  const editable = OVERLAY_EDITABLE.has(project.state);

  if (!script) return <p className="text-sm text-muted-foreground">{t('noScript')}</p>;
  const shot = script.shots.find((s) => s.id === shotId);
  const presetList = presets.data?.data ?? [];
  const stateLabel = f.projectState(project.state).label;

  return (
    <div className="flex flex-col gap-10">
      {presets.error && <ErrorState error={presets.error} onRetry={() => void presets.mutate()} />}
      {!editable && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t('readOnly', {
            // English reads the state mid-sentence ("while the project is published").
            state: f.locale.startsWith('en') ? stateLabel.toLowerCase() : stateLabel,
          })}
        </p>
      )}
      <div className="flex flex-col gap-3">
        <ScriptSelect
          id="overlay-script"
          project={project}
          value={script.id}
          onChange={(id) => {
            setScriptId(id);
            setShotId(project.scripts.find((s) => s.id === id)?.shots[0]?.id ?? null);
          }}
        />
        <ShotStrip
          label={t('shotStripLabel')}
          shots={script.shots}
          selectedId={shotId}
          onSelect={setShotId}
        />
      </div>
      {shot ? (
        <ShotOverlays
          key={shot.id}
          shotId={shot.id}
          duration={shot.durationSec}
          aspectRatio={script.targetAspectRatio}
          platform={script.targetPlatform}
          editable={editable}
          presets={presetList}
          businessId={businessId}
          onPresetsChanged={() => void presets.mutate()}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('selectShot')}</p>
      )}
      <Section title={t('wholeVideo')} description={t('wholeVideoDescription')}>
        <WholeVideoOverlays
          project={project}
          editable={editable}
          presets={presetList}
          businessId={businessId}
          onPresetsChanged={() => void presets.mutate()}
        />
      </Section>
      <Section title={t('across')} description={t('acrossDescription')}>
        <BulkApply
          project={project}
          presets={presetList}
          editable={editable}
          onApplied={() => {
            onChanged();
            // Per-shot bulk overlays land on shots: refresh every loaded shot-overlay list.
            void mutateCache(
              (key) => typeof key === 'string' && /\/shots\/[^/]+\/overlays/.test(key),
            );
          }}
          onRerendered={onChanged}
        />
      </Section>
    </div>
  );
}
