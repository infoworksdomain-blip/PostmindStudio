'use client';

import { useState, type KeyboardEvent } from 'react';
import { Eye, Loader2, Redo2, Save, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ErrorState } from '../primitives';
import { useAction } from '../review/use-action';
import {
  commit,
  emptyHistory,
  historyKey,
  redo,
  undo,
  withChange,
  without,
  type Drafts,
} from './draft-history';
import { OverlayForm } from './overlay-form';
import { OverlayFrame } from './overlay-frame';
import { applyDraft, buildPatch, draftProblems, newOverlayTiming } from './overlay-math';
import { OverlayTimeline } from './overlay-timeline';
import { AddOverlay, ManagePresets, SavePreset } from './preset-controls';
import { safeAreaFor } from './safe-areas';
import type { Overlay, OverlayDraft, OverlayPreset, OverlayPreviewResult } from './types';

// One set of overlays — a shot's, a slide's (13.4) or a render's whole-video lane (13.3): live
// frame preview with the platform safe area and a resize handle, mini-timeline, style panel with
// undo / redo (13.7), add / save / delete, server preview render, and presets.

export interface OverlaySetProps {
  /** GET list endpoint returning { data: Overlay[] }. */
  listPath: string;
  /** How to create one overlay: path + body; the response's overlay id is selected. */
  create: (input: {
    text: string;
    startAtSec: number;
    endAtSec: number;
    presetId: string | null;
  }) => { path: string; body: Record<string, unknown>; pick: (res: unknown) => string | null };
  maxCount: number;
  duration: number;
  aspectRatio: string;
  platform?: string;
  editable: boolean;
  presets: OverlayPreset[];
  businessId: string | null;
  onPresetsChanged: () => void;
  /** Server preview renders exist for shot overlays only. */
  canPreview?: boolean;
  /** What the timing is relative to, for the empty-state text. */
  unit?: string;
}

export function OverlaySet({
  listPath,
  create,
  maxCount,
  duration,
  aspectRatio,
  platform,
  editable,
  presets,
  businessId,
  onPresetsChanged,
  canPreview = true,
  unit = 'shot',
}: OverlaySetProps) {
  const { data, error, isLoading, mutate } = useApi<{ data: Overlay[] }>(listPath);
  const { pending, run, busy } = useAction();
  const [history, setHistory] = useState(emptyHistory);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return <Skeleton className="h-72 rounded-xl" aria-label="Loading overlays" />;

  const drafts = history.present;
  const overlays = data.data.map((o) => applyDraft(o, drafts[o.id]));
  const original = data.data.find((o) => o.id === selectedId);
  const selected = overlays.find((o) => o.id === selectedId);
  const patch = original ? buildPatch(original, drafts[original.id]) : null;
  const problems = selected ? draftProblems(selected, duration) : [];
  const full = data.data.length >= maxCount;
  const safeArea = platform ? safeAreaFor(platform, aspectRatio) : null;
  const idPrefix = `${listPath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-/, '')}-`;

  const change = (next: Drafts) => setHistory((h) => commit(h, next));
  const draft = (id: string, c: OverlayDraft) => change(withChange(drafts, id, c));
  const discard = (id: string) => change(without(drafts, id));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // Text fields keep their own native undo.
    if (target.closest('input[type="text"], input:not([type]), textarea')) return;
    const action = historyKey(e);
    if (!action) return;
    e.preventDefault();
    setHistory((h) => (action === 'undo' ? undo(h) : redo(h)));
  }

  async function add(text: string, presetId: string | null): Promise<boolean> {
    const timing = newOverlayTiming(playhead, duration);
    const request = create({ text, ...timing, presetId });
    const result = await run<unknown>('add', request.path, {
      body: request.body,
      success: 'Overlay added.',
    });
    if (!result) return false;
    await mutate();
    setSelectedId(request.pick(result));
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
    <div className="flex flex-col gap-5" onKeyDown={onKeyDown}>
      <AddOverlay
        presets={presets}
        disabled={!editable || full}
        adding={pending === 'add'}
        onAdd={add}
        idPrefix={idPrefix}
      />
      {full && (
        <p className="text-xs text-muted-foreground">
          This {unit} has the maximum of {maxCount} overlays.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="flex flex-col gap-3">
          <OverlayFrame
            overlays={overlays}
            aspectRatio={aspectRatio}
            playhead={playhead}
            selectedId={selectedId}
            safeArea={safeArea}
            onPlace={editable && selectedId ? (anchor) => draft(selectedId, anchor) : undefined}
            onResize={
              editable && selectedId
                ? (fontSizePct) => draft(selectedId, { fontSizePct })
                : undefined
            }
          />
          {safeArea && (
            <p className="text-[0.7rem] text-muted-foreground">
              <span
                aria-hidden
                className={
                  safeArea.official
                    ? 'mr-1 inline-block size-2 border border-emerald-500'
                    : 'mr-1 inline-block size-2 border border-dashed border-amber-500'
                }
              />
              {safeArea.label}
            </p>
          )}
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
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHistory(undo)}
              disabled={history.past.length === 0}
              aria-keyshortcuts="Control+Z"
            >
              <Undo2 /> Undo
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHistory(redo)}
              disabled={history.future.length === 0}
              aria-keyshortcuts="Control+Shift+Z"
            >
              <Redo2 /> Redo
            </Button>
          </div>
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
            unit={unit}
          />
          {selected && original ? (
            <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
              <OverlayForm
                overlay={selected}
                duration={duration}
                disabled={!editable}
                onDraft={(c) => draft(selected.id, c)}
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
                {canPreview && (
                  <Button
                    variant="outline"
                    onClick={renderPreview}
                    disabled={Boolean(patch) || busy}
                    title={patch ? 'Save first — the preview renders the saved overlay' : undefined}
                  >
                    {pending === 'preview' ? <Loader2 className="animate-spin" /> : <Eye />}
                    Preview render
                  </Button>
                )}
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
              <SavePreset
                overlay={selected}
                businessId={businessId}
                onSaved={onPresetsChanged}
                idPrefix={idPrefix}
              />
              <ManagePresets
                presets={presets}
                overlay={selected}
                disabled={!editable}
                onChanged={onPresetsChanged}
                idPrefix={idPrefix}
              />
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
