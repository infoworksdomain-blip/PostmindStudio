'use client';

import { useState } from 'react';
import { PLATFORM_LABEL } from '@/lib/client/format';
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
  if (project.scripts.length < 2) return null;
  return (
    <Field id={id} label="Variant" className="w-full sm:w-64">
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {project.scripts.map((s) => (
          <option key={s.id} value={s.id}>
            {PLATFORM_LABEL[s.targetPlatform] ?? s.targetPlatform} ({s.targetAspectRatio})
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function ShotsTab({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const [scriptId, setScriptId] = useState(project.scripts[0]?.id ?? '');
  const [shotId, setShotId] = useState<string | null>(null);
  const script = project.scripts.find((s) => s.id === scriptId) ?? project.scripts[0];
  if (!script)
    return (
      <p className="text-sm text-muted-foreground">Shots appear once the script is written.</p>
    );
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
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a shot to regenerate it or change its narration.
        </p>
      )}
    </div>
  );
}
