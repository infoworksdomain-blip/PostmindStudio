'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Clapperboard, Layers, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PLATFORM_LABEL } from '@/lib/client/format';
import type { ProjectDetail, Render } from '@/lib/client/types';
import { Field, NativeSelect } from '../review/field';
import { useAction } from '../review/use-action';
import { PresetSelect } from './preset-controls';
import { RERENDERABLE, type OverlayPreset } from './types';

// A4.8 bulk overlays (e.g. a persistent watermark across the whole video, or the same caption on
// several shots) and "re-render with current overlays" (no generation spend).

const renderLabel = (r: Render) =>
  `${PLATFORM_LABEL[r.targetPlatform] ?? r.targetPlatform} (${r.aspectRatio})`;

export function BulkApply({
  project,
  presets,
  editable,
  onApplied,
  onRerendered,
}: {
  project: ProjectDetail;
  presets: OverlayPreset[];
  editable: boolean;
  onApplied: () => void;
  onRerendered: () => void;
}) {
  const renders = project.renders;
  const [renderId, setRenderId] = useState(renders[0]?.id ?? '');
  const [text, setText] = useState('');
  const [presetId, setPresetId] = useState('');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('2');
  const [target, setTarget] = useState<'video' | 'shots'>('video');
  const [shotIds, setShotIds] = useState<string[]>([]);
  const { pending, run, busy } = useAction();

  const render = renders.find((r) => r.id === renderId) ?? renders[0];
  if (!render) return <p className="text-sm text-muted-foreground">No renders yet.</p>;
  const shots = project.scripts.find((s) => s.id === render.scriptId)?.shots ?? [];
  const startSec = Number(start);
  const endSec = Number(end);
  const valid =
    text.trim() !== '' &&
    Number.isFinite(startSec) &&
    Number.isFinite(endSec) &&
    endSec > startSec &&
    startSec >= 0 &&
    (target === 'video' || shotIds.length > 0);

  async function apply(e: FormEvent) {
    e.preventDefault();
    if (!render || !valid) return;
    const result = await run<{ data: unknown[] }>('bulk', `/renders/${render.id}/overlays/bulk`, {
      body: {
        overlay: {
          text: text.trim(),
          startAtSec: startSec,
          endAtSec: endSec,
          ...(presetId && { presetId }),
        },
        ...(target === 'shots' && { applyToShotIds: shotIds }),
      },
    });
    if (result) {
      toast.success(`Added ${result.data.length} overlay${result.data.length === 1 ? '' : 's'}.`);
      setText('');
      onApplied();
    }
  }

  async function rerender() {
    if (!render) return;
    const ok = await run('rerender', `/renders/${render.id}/rerender`, {
      success: 'Re-rendering with the current overlays.',
    });
    if (ok) onRerendered();
  }

  const toggleShot = (id: string) =>
    setShotIds((ids) => (ids.includes(id) ? ids.filter((s) => s !== id) : [...ids, id]));

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={apply} className="grid gap-3 sm:grid-cols-2">
        <Field id="bulk-render" label="Variant">
          <NativeSelect
            id="bulk-render"
            value={render.id}
            onChange={(e) => {
              setRenderId(e.target.value);
              setShotIds([]);
            }}
          >
            {renders.map((r) => (
              <option key={r.id} value={r.id}>
                {renderLabel(r)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="bulk-preset" label="Preset">
          <PresetSelect
            id="bulk-preset"
            presets={presets}
            value={presetId}
            onChange={setPresetId}
          />
        </Field>
        <Field id="bulk-text" label="Text" className="sm:col-span-2">
          <Input
            id="bulk-text"
            value={text}
            maxLength={500}
            placeholder="@yourbrand"
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field id="bulk-start" label="Start (s)">
          <Input
            id="bulk-start"
            type="number"
            min={0}
            step={0.1}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field id="bulk-end" label="End (s)">
          <Input
            id="bulk-end"
            type="number"
            min={0}
            step={0.1}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Apply to</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="bulk-target"
                checked={target === 'video'}
                onChange={() => setTarget('video')}
              />
              Whole video (timing from the start of the video)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="bulk-target"
                checked={target === 'shots'}
                onChange={() => setTarget('shots')}
              />
              Selected shots (timing within each shot)
            </label>
          </div>
          {target === 'shots' && (
            <div className="mt-3 flex flex-wrap gap-3">
              {shots.map((s, i) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={shotIds.includes(s.id)}
                    onChange={() => toggleShot(s.id)}
                  />
                  Shot {i + 1}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={!editable || !valid || busy}>
            {pending === 'bulk' ? <Loader2 className="animate-spin" /> : <Layers />} Apply overlay
          </Button>
          <p className="text-xs text-muted-foreground">
            Whole-video overlays are listed and edited in the Whole video lane above — they appear
            in the next render.
          </p>
        </div>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          Overlay edits apply when the video is re-rendered. No new footage is generated.
        </p>
        <Button
          variant="outline"
          onClick={rerender}
          disabled={!RERENDERABLE.has(project.state) || busy}
          title={
            RERENDERABLE.has(project.state)
              ? undefined
              : 'Re-render is available once the video is ready for review'
          }
        >
          {pending === 'rerender' ? <Loader2 className="animate-spin" /> : <Clapperboard />}
          Re-render video
        </Button>
      </div>
    </div>
  );
}
