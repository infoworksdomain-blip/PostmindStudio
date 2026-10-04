'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Plus, RefreshCw, Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { ErrorState, Section } from '../primitives';
import { useAction } from '../review/use-action';
import {
  addPost,
  draftFromView,
  editBody,
  movePost,
  removePost,
  sameDraft,
  slidesOfPost,
  updatePost,
  type CarouselDraft,
  type CarouselPreview,
  type CarouselTheme,
  type CarouselView,
} from './model';
import { PostCardEditor } from './post-card-editor';
import { SlidePreview } from './slide-preview';

// BACKLOG 21.6 — the carousel editor (post cards). Text per post, pictures, order, look, the name
// and handle on the cards; a live preview rendered by the server exactly as the final slides
// (POST /carousel/preview, debounced); save, render again, AI rewrites, and downloads.

export const PREVIEW_DEBOUNCE_MS = 700;
const THEMES: CarouselTheme[] = ['light', 'dark'];

export function CarouselEditor({
  projectId,
  projectState,
  businessId,
  onChanged,
}: {
  projectId: string;
  /** The project's state: the carousel is reloaded when it changes (a render finished). */
  projectState: string;
  businessId: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations('carousel.editor');
  const errorMessage = useErrorMessage();
  const { pending, run, busy } = useAction();
  const { data, error, isLoading, mutate } = useApi<{ carousel: CarouselView }>(
    `/projects/${projectId}/carousel`,
  );
  const view = data?.carousel;
  const [draft, setDraft] = useState<CarouselDraft | null>(null);
  const [preview, setPreview] = useState<CarouselPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState(0);
  const lastState = useRef(projectState);

  useEffect(() => {
    if (lastState.current === projectState) return;
    lastState.current = projectState;
    void mutate();
  }, [projectState, mutate]);
  // A fresh server copy replaces the draft only when the draft has no unsaved edits.
  const saved = useMemo(() => (view ? draftFromView(view) : null), [view]);
  const previousSaved = useRef<CarouselDraft | null>(null);
  useEffect(() => {
    if (!saved) return;
    const before = previousSaved.current;
    previousSaved.current = saved;
    setDraft((d) => (!d || (before && sameDraft(d, before)) ? saved : d));
  }, [saved]);

  const body = draft ? JSON.stringify(editBody(draft)) : null;
  useEffect(() => {
    if (!body || !draft || draft.posts.every((p) => !p.text.trim())) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewing(true);
      api<{ preview: CarouselPreview }>(`/projects/${projectId}/carousel/preview`, {
        method: 'POST',
        body: JSON.parse(body) as unknown,
        signal: controller.signal,
      })
        .then((res) => {
          setPreview(res.preview);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setPreviewError(errorMessage(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialised body is the trigger
  }, [body, projectId]);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !view || !draft)
    return <Skeleton className="h-96 rounded-xl" aria-label={t('loading')} />;

  const editable = view.editable;
  const dirty = saved ? !sameDraft(draft, saved) : false;
  const slides = preview?.slides ?? [];
  const current = slides[Math.min(selected, Math.max(0, slides.length - 1))];
  const change = (next: CarouselDraft) => setDraft(next);

  async function save(): Promise<boolean> {
    if (!draft) return false;
    const res = await run<{ carousel: CarouselView }>('save', `/projects/${projectId}/carousel`, {
      method: 'PUT',
      body: editBody(draft),
      success: t('saved'),
    });
    if (res) await mutate(res, { revalidate: false });
    return res !== null;
  }
  async function saveAndRender() {
    if (dirty && !(await save())) return;
    const res = await run('render', `/projects/${projectId}/carousel/render`, {
      success: t('rendering'),
    });
    if (res) onChanged();
  }
  async function rewrite(postId?: string) {
    if (dirty && !(await save())) return;
    const res = await run<{ carousel: CarouselView }>(
      postId ? `rewrite:${postId}` : 'rewrite',
      `/projects/${projectId}/carousel/rewrite`,
      {
        body: postId ? { postId } : {},
        success: postId ? t('postRewritten') : t('threadRewritten'),
      },
    );
    if (res) {
      setDraft(draftFromView(res.carousel));
      await mutate(res, { revalidate: false });
    }
  }
  async function downloadAll() {
    const res = await run<{ url: string }>('download', `/projects/${projectId}/carousel/download`);
    if (res?.url) window.open(res.url, '_blank', 'noopener');
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
      <Section title={t('postsTitle')} description={t('postsDescription')}>
        {!editable && (
          <p className="mb-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            {t('readOnly')}
          </p>
        )}
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="carousel-name" className="text-sm">
              {t('displayName')}
            </label>
            <Input
              id="carousel-name"
              value={draft.displayName}
              maxLength={50}
              dir="auto"
              disabled={!editable}
              onChange={(e) => change({ ...draft, displayName: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="carousel-handle" className="text-sm">
              {t('handle')}
            </label>
            <Input
              id="carousel-handle"
              value={draft.handle}
              maxLength={31}
              dir="ltr"
              disabled={!editable}
              onChange={(e) => change({ ...draft, handle: e.target.value })}
            />
          </div>
        </div>
        <div className="mb-4 flex items-center gap-2">
          <span id="carousel-editor-theme" className="text-sm">
            {t('theme')}
          </span>
          <div role="radiogroup" aria-labelledby="carousel-editor-theme" className="flex gap-1.5">
            {THEMES.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={draft.theme === key}
                disabled={!editable}
                onClick={() => change({ ...draft, theme: key })}
                className={cn(
                  'rounded-lg border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  draft.theme === key
                    ? 'border-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`themes.${key}`)}
              </button>
            ))}
          </div>
        </div>
        {draft.posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noPosts')}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {draft.posts.map((post, index) => (
              <PostCardEditor
                key={post.id}
                post={post}
                index={index}
                count={draft.posts.length}
                slides={slidesOfPost(slides, post.id)}
                imageUrl={post.imageId ? (view.images[post.imageId] ?? null) : null}
                businessId={businessId}
                disabled={!editable || busy}
                rewriting={pending === `rewrite:${post.id}`}
                canRewrite={view.rewritesLeft > 0}
                onChange={(patch) => change(updatePost(draft, post.id, patch))}
                onMove={(by) => change(movePost(draft, post.id, by))}
                onRemove={() => change(removePost(draft, post.id))}
                onRewrite={() => void rewrite(post.id)}
              />
            ))}
          </ol>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!editable || busy || draft.posts.length >= 12}
            onClick={() => change(addPost(draft, crypto.randomUUID()))}
          >
            <Plus /> {t('addPost')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!editable || busy || view.rewritesLeft === 0}
            onClick={() => void rewrite()}
          >
            {pending === 'rewrite' ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {t('rewriteThread')}
          </Button>
          <span className="self-center text-xs text-muted-foreground">
            {t('rewritesLeft', { count: view.rewritesLeft })}
          </span>
        </div>
        <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-4">
          <Button type="button" disabled={!editable || busy || !dirty} onClick={() => void save()}>
            {pending === 'save' ? <Loader2 className="animate-spin" /> : <Save />} {t('save')}
          </Button>
          {view.canRerender && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void saveAndRender()}
            >
              {pending === 'render' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {dirty ? t('saveAndRender') : t('renderAgain')}
            </Button>
          )}
          {view.render && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void downloadAll()}
            >
              <Download /> {t('downloadAll')}
            </Button>
          )}
        </div>
        {dirty && view.render && (
          <p className="mt-2 text-xs text-muted-foreground">{t('unsavedNote')}</p>
        )}
      </Section>
      <SlidePreview
        slides={slides}
        current={current}
        onSelect={setSelected}
        previewing={previewing}
        previewError={previewError}
        issues={preview?.issues ?? []}
        removedCharacters={preview?.removedCharacters ?? 0}
        render={view.render}
        aiGenerated={view.render?.aiGenerated ?? false}
      />
    </div>
  );
}
