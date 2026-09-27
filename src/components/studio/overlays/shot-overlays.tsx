'use client';

import { useState } from 'react';
import { Eye, Loader2, Save, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ErrorState } from '../primitives';
import { useAction } from '../review/use-action';
import { OverlayForm } from './overlay-form';
import { OverlayFrame } from './overlay-frame';
import { applyDraft, buildPatch, draftProblems, newOverlayTiming } from './overlay-math';
import { OverlayTimeline } from './overlay-timeline';
import { AddOverlay, SavePreset } from './preset-controls';
import {
  MAX_OVERLAYS_PER_SHOT,
  type Overlay,
  type OverlayDraft,
  type OverlayPreset,
  type OverlayPreviewResult,
} from './types';

// One shot's overlays (A4.1): live frame preview, mini-timeline, style panel, add / save /
// delete, server preview render, and save-as-preset.

export function ShotOverlays({
  shotId,
  duration,
  aspectRatio,
  editable,
  presets,
  businessId,
  onPresetsChanged,
}: {
  shotId: string;
  duration: number;
  aspectRatio: string;
  editable: boolean;
  presets: OverlayPreset[];
  businessId: string | null;
  onPresetsChanged: () => void;
}) {
  const { data, error, isLoading, mutate } = useApi<{ data: Overlay[] }>(
    `/shots/${shotId}/overlays`,
  );
  const { pending, run, busy } = useAction();
  const [drafts, setDrafts] = useState<Record<string, OverlayDraft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return <Skeleton className="h-72 rounded-xl" aria-label="Loading overlays" />;

  const overlays = data.data.map((o) => applyDraft(o, drafts[o.id]));
  const original = data.data.find((o) => o.id === selectedId);
  const selected = overlays.find((o) => o.id === selectedId);
  const patch = original ? buildPatch(original, drafts[original.id]) : null;
  const problems = selected ? draftProblems(selected, duration) : [];
  const full = data.data.length >= MAX_OVERLAYS_PER_SHOT;

  const draft = (id: string, change: OverlayDraft) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...change } }));
  const discard = (id: string) =>
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)));

  async function add(text: string, presetId: string | null): Promise<boolean> {
    const timing = newOverlayTiming(playhead, duration);
    const result = await run<{ overlay: Overlay }>('add', `/shots/${shotId}/overlays`, {
      body: { text, ...timing, ...(presetId && { presetId }) },
      success: 'Overlay added.',
    });
    if (!result) return false;
    await mutate();
    setSelectedId(result.overlay.id);
    return true;
  }

  async function save() {
    if (!original || !patch) return;
    const ok = await run('save', `/overlays/${original.id}`, {
      method: 'PATCH',
      body: patch,
      success: 'Overlay saved — re-render to apply it.',
    });
    if (ok) {
      await mutate();
      discard(original.id);
      setPreview(null);
    }
  }

  async function remove() {
    if (!original) return;
    const ok = await run('delete', `/overlays/${original.id}`, {
      method: 'DELETE',
      success: 'Overlay deleted.',
    });
    if (ok) {
      discard(original.id);
      setSelectedId(null);
      await mutate();
    }
  }

  async function renderPreview() {
    if (!original) return;
    const result = await run<OverlayPreviewResult>('preview', `/overlays/${original.id}/preview`);
    if (result) setPreview(result.preview.url);
  }

  return (
    <div className="flex flex-col gap-5">
      <AddOverlay
        presets={presets}
        disabled={!editable || full}
        adding={pending === 'add'}
        onAdd={add}
      />
      {full && (
        <p className="text-xs text-muted-foreground">
          This shot has the maximum of {MAX_OVERLAYS_PER_SHOT} overlays.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="flex flex-col gap-3">
          <OverlayFrame
            overlays={overlays}
            aspectRatio={aspectRatio}
            playhead={playhead}
            selectedId={selectedId}
            onPlace={editable && selectedId ? (anchor) => draft(selectedId, anchor) : undefined}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Playhead</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={playhead}
              aria-label="Playhead position (seconds)"
              onChange={(e) => setPlayhead(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <span className="tabular w-10 shrink-0 text-right">{playhead.toFixed(1)}s</span>
          </label>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <OverlayTimeline
            overlays={overlays}
            duration={duration}
            playhead={playhead}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onTiming={(id, timing) => draft(id, timing)}
            onSeek={setPlayhead}
            disabled={!editable}
          />
          {selected && original ? (
            <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
              <OverlayForm
                overlay={selected}
                duration={duration}
                disabled={!editable}
                onDraft={(change) => draft(selected.id, change)}
              />
              {problems.length > 0 && (
                <ul role="alert" className="text-xs text-destructive">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={save}
                  disabled={!editable || !patch || problems.length > 0 || busy}
                >
                  {pending === 'save' ? <Loader2 className="animate-spin" /> : <Save />} Save
                </Button>
                <Button variant="ghost" onClick={() => discard(selected.id)} disabled={!patch}>
                  <Undo2 /> Discard changes
                </Button>
                <Button
                  variant="outline"
                  onClick={renderPreview}
                  disabled={Boolean(patch) || busy}
                  title={patch ? 'Save first — the preview renders the saved overlay' : undefined}
                >
                  {pending === 'preview' ? <Loader2 className="animate-spin" /> : <Eye />}
                  Preview render
                </Button>
                <Button variant="destructive" onClick={remove} disabled={!editable || busy}>
                  {pending === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Delete
                </Button>
              </div>
              {preview && (
                <video
                  src={preview}
                  controls
                  autoPlay
                  muted
                  playsInline
                  aria-label="Overlay preview render"
                  className="max-h-80 w-full rounded-lg bg-foreground"
                />
              )}
              <SavePreset overlay={selected} businessId={businessId} onSaved={onPresetsChanged} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select an overlay on the timeline to style and time it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
