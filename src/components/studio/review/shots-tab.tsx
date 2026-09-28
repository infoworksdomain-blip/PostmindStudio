'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { Field, NativeSelect } from './field';
import { ShotPanel } from './shot-panel';
import { ShotStrip } from './shot-strip';

// Shots tab: pick the variant's script, then a shot from its strip to regenerate or edit it.

export function ScriptSelect({
  project,
  value,
  onChange,
  id,
}: {
  project: ProjectDetail;
  value: string;
  onChange: (scriptId: string) => void;
  id: string;
}) {
  const t = useTranslations('review.shots');
  const f = useFormat();
  if (project.scripts.length < 2) return null;
  return (
    <Field id={id} label={t('variant')} className="w-full sm:w-64">
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {project.scripts.map((s) => (
          <option key={s.id} value={s.id}>
            {t('variantOption', {
              platform: f.platform(s.targetPlatform),
              ratio: s.targetAspectRatio,
            })}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function ShotsTab({
  project,
  onChanged,
  businessId = null,
}: {
  project: ProjectDetail;
  onChanged: () => void;
  businessId?: string | null;
}) {
  const t = useTranslations('review.shots');
  const [scriptId, setScriptId] = useState(project.scripts[0]?.id ?? '');
  const [shotId, setShotId] = useState<string | null>(null);
  const script = project.scripts.find((s) => s.id === scriptId) ?? project.scripts[0];
  if (!script) return <p className="text-sm text-muted-foreground">{t('noScript')}</p>;
  const index = script.shots.findIndex((s) => s.id === shotId);

  return (
    <div className="flex flex-col gap-4">
      <ScriptSelect
        id="shots-script"
        project={project}
        value={script.id}
        onChange={(id) => {
          setScriptId(id);
          setShotId(null);
        }}
      />
      <ShotStrip shots={script.shots} selectedId={shotId} onSelect={setShotId} />
      {shotId && index >= 0 ? (
        <ShotPanel
          key={shotId}
          shotId={shotId}
          index={index}
          projectState={project.state}
          onChanged={onChanged}
          businessId={businessId}
          isLastShot={script.shots.length <= 1}
          onDeleted={() => {
            setShotId(null);
            onChanged();
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('select')}</p>
      )}
    </div>
  );
}
