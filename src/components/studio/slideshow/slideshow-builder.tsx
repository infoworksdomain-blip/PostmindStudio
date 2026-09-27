'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  Loader2,
  Plus,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatDuration } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { ErrorState } from '../primitives';
import { Field, NativeSelect } from '../review/field';
import { useAction } from '../review/use-action';
import { SlideEditor, type SlidePatch } from './slide-editor';
import { SLIDE_TYPE_LABEL, SLIDE_TYPES, type Slide, type SlideType } from './types';

// BACKLOG 10.8 — slideshow builder (A5): slides in order with what each still needs, edit,
// reorder, add, delete, auto-populate from the image library (A5.5), save as a template (A5.7).

const EDITABLE = new Set(['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW']);

export function slideSummary(slide: Slide): string {
  const c = slide.content;
  return (
    c.text ||
    c.quote ||
    (c.value && `${c.value} ${c.label ?? ''}`.trim()) ||
    c.name ||
    c.caption ||
    (c.pendingText ? 'Text to be written by auto-populate' : '') ||
    'No text'
  );
}

export function SlideshowBuilder({
  project,
  businessId,
  onChanged,
}: {
  project: ProjectDetail;
  businessId: string | null;
  onChanged: () => void;
}) {
  const populating = project.state === 'SCANNING';
  const { data, error, isLoading, mutate } = useApi<{ data: Slide[] }>(
    `/projects/${project.id}/slides`,
    undefined,
    { refreshInterval: populating ? 4000 : 0 },
  );
  const { pending, run, busy } = useAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newType, setNewType] = useState<SlideType>('TEXT_CARD');
  const [templateName, setTemplateName] = useState('');
  const editable = EDITABLE.has(project.state);
  const wasPopulating = useRef(populating);

  // Auto-populate finished (project left SCANNING): load the filled-in slides once more.
  useEffect(() => {
    if (wasPopulating.current && !populating) void mutate();
    wasPopulating.current = populating;
  }, [populating, mutate]);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return (
      <div className="flex flex-col gap-2" aria-label="Loading slides">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );

  const slides = data.data;
  const total = slides.reduce((sum, s) => sum + s.durationSec, 0);
  const needing = slides.filter((s) => s.problem).length;

  async function reorder(slide: Slide, newSortOrder: number) {
    const result = await run<{ data: Slide[] }>(`move-${slide.id}`, `/slides/${slide.id}/reorder`, {
      body: { newSortOrder },
    });
    if (result) await mutate({ data: result.data }, { revalidate: false });
  }

  async function remove(slide: Slide) {
    const ok = await run(`delete-${slide.id}`, `/slides/${slide.id}`, {
      method: 'DELETE',
      success: 'Slide deleted.',
    });
    if (ok) await mutate();
  }

  async function save(slide: Slide, patch: SlidePatch) {
    const ok = await run(`save-${slide.id}`, `/slides/${slide.id}`, {
      method: 'PATCH',
      body: patch,
      success: 'Slide saved.',
    });
    if (ok) {
      setOpenId(null);
      await mutate();
    }
  }

  async function add() {
    const ok = await run<{ slide: Slide }>('add', `/projects/${project.id}/slides`, {
      body: { slideType: newType },
    });
    if (ok) {
      await mutate();
      setOpenId(ok.slide.id);
    }
  }

  async function autoPopulate() {
    const ok = await run('populate', `/projects/${project.id}/auto-populate`, {
      success: 'Auto-populating text and images from your library…',
    });
    if (ok) onChanged();
  }

  async function saveTemplate(e: FormEvent) {
    e.preventDefault();
    const ok = await run('template', '/slideshow-templates', {
      body: { projectId: project.id, name: templateName.trim() },
      success: 'Saved as a template.',
    });
    if (ok) setTemplateName('');
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="tabular text-sm text-muted-foreground">
          {slides.length} slides · {formatDuration(total)}
          {needing > 0 && <span className="text-foreground"> · {needing} need attention</span>}
        </p>
        <Button variant="outline" onClick={autoPopulate} disabled={!editable || busy || populating}>
          {pending === 'populate' || populating ? <Loader2 className="animate-spin" /> : <Wand2 />}
          {populating ? 'Auto-populating…' : 'Auto-populate'}
        </Button>
      </div>
      {slides.length === 0 && (
        <p className="text-sm text-muted-foreground">No slides yet — add one below.</p>
      )}
      <ol className="flex flex-col gap-2">
        {slides.map((slide, i) => {
          const open = openId === slide.id;
          return (
            <li
              key={slide.id}
              className={cn(
                'rounded-lg border bg-card',
                slide.problem ? 'border-warning/60' : 'border-border',
              )}
            >
              <div className="flex items-center gap-2 p-2 sm:gap-3 sm:p-3">
                <span className="tabular w-6 shrink-0 text-center font-display text-xl">
                  {i + 1}
                </span>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : slide.id)}
                  className="min-w-0 flex-1 rounded text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="block truncate text-sm">{slideSummary(slide)}</span>
                  <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {SLIDE_TYPE_LABEL[slide.slideType]} · {formatDuration(slide.durationSec)}
                    {slide.problem && (
                      <>
                        <AlertTriangle aria-hidden className="size-3 text-warning" />
                        <span>{slide.problem}</span>
                      </>
                    )}
                  </span>
                </button>
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'hidden size-4 text-muted-foreground transition-transform sm:block',
                    open && 'rotate-180',
                  )}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move slide ${i + 1} up`}
                  disabled={!editable || busy || i === 0}
                  onClick={() => reorder(slide, i - 1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move slide ${i + 1} down`}
                  disabled={!editable || busy || i === slides.length - 1}
                  onClick={() => reorder(slide, i + 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete slide ${i + 1}`}
                  disabled={!editable || busy}
                  onClick={() => remove(slide)}
                >
                  <Trash2 />
                </Button>
              </div>
              {open && editable && (
                <div className="px-2 pb-2 sm:px-3 sm:pb-3">
                  <SlideEditor
                    slide={slide}
                    businessId={businessId}
                    saving={pending === `save-${slide.id}`}
                    onSave={(patch) => save(slide, patch)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {editable && (
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div className="flex items-end gap-2">
            <Field id="new-slide-type" label="Add a slide" className="flex-1">
              <NativeSelect
                id="new-slide-type"
                value={newType}
                onChange={(e) => setNewType(e.target.value as SlideType)}
              >
                {SLIDE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SLIDE_TYPE_LABEL[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button variant="outline" onClick={add} disabled={busy || slides.length >= 40}>
              {pending === 'add' ? <Loader2 className="animate-spin" /> : <Plus />} Add
            </Button>
          </div>
          <form onSubmit={saveTemplate} className="flex items-end gap-2">
            <Field id="template-name" label="Save as template" className="flex-1">
              <Input
                id="template-name"
                value={templateName}
                maxLength={120}
                placeholder="Template name"
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !templateName.trim() || slides.length === 0}
            >
              {pending === 'template' ? <Loader2 className="animate-spin" /> : <BookmarkPlus />}{' '}
              Save
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
