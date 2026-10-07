'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Lock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { Page } from '@/lib/client/types';
import { emitUpgrade } from '@/lib/client/upgrade-events';
import { StudioCapability } from '@/lib/rbac';
import { tierAtLeast } from '@/lib/studio/billing/catalogue';
import { minTierForFeature, PlanLockBadge, usePlanTier } from '../billing/plan-lock-badge';
import { useBusiness } from '../business-context';
import type { LibraryImage } from '../business/types';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { useCan } from '../use-can';
import { ImagePreviewDialog } from './image-preview-dialog';
import { ImagePromptForm } from './image-prompt-form';
import { ImageResults } from './image-results';
import { generateBody, type ImageAspect, type ImageRequest } from './image-studio-model';

// BACKLOG 25.8 — Image Studio (/images): generate pictures for the business from a prompt and keep
// them in its image library. POST /image-library/generate (A6.3, Plus and above, monthly cap per
// business) and GET /image-library?source=generated, both behind the `image-library` feature flag.
// Business → Images still manages the whole library (uploads, site photos, stock).

const PAGE_SIZE = 30;
const EMPTY: ImageRequest = { prompt: '', style: '', aspectRatio: '1:1' };

/** Plan check (the server still enforces it; a refused call opens the upgrade dialog). */
function usePlanLocked(): boolean {
  const tier = usePlanTier();
  return tier !== undefined && !tierAtLeast(tier, minTierForFeature('imageGeneration'));
}

function LockedNote() {
  const t = useTranslations('images.locked');
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/50 p-4 text-sm">
      <p className="flex items-start gap-2">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>
          <span className="font-medium">{t('title')}</span>{' '}
          <PlanLockBadge feature="imageGeneration" />
          <span className="mt-1 block text-muted-foreground">{t('body')}</span>
        </span>
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => emitUpgrade({ code: 'plan_tier', status: 403, message: t('title') })}
        >
          {t('action')}
        </Button>
      </div>
    </div>
  );
}

export function ImageStudioScreen() {
  const t = useTranslations('images');
  const tn = useTranslations('shell.nav.groups');
  const { businessId, ready } = useBusiness();
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const locked = usePlanLocked();
  const errorMessage = useErrorMessage();
  const [request, setRequest] = useState<ImageRequest>(EMPTY);
  const [last, setLast] = useState<ImageRequest | null>(null);
  const [pending, setPending] = useState<ImageAspect | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [preview, setPreview] = useState<LibraryImage | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const list = useApi<Page<LibraryImage>>(businessId ? '/image-library' : null, {
    businessId: businessId ?? undefined,
    source: 'generated',
    cursor: cursors.at(-1),
    limit: PAGE_SIZE,
  });
  const flagOff = list.error instanceof ApiError && list.error.code === 'feature_disabled';
  const canGenerate = mayWrite && !locked && !flagOff;

  async function generate(next: ImageRequest) {
    if (!businessId || pending) return;
    setPending(next.aspectRatio);
    setLast(next);
    setAnnouncement(t('status.generating'));
    try {
      await api('/image-library/generate', {
        method: 'POST',
        body: generateBody(businessId, next),
        idempotencyKey: newIdempotencyKey(),
      });
      setAnnouncement(t('status.ready'));
      toast.success(t('status.ready'));
      setCursors([]);
      await list.mutate();
    } catch (err) {
      setAnnouncement(t('status.failed'));
      // Plan and billing blocks open the upgrade dialog themselves (api() → upgrade events).
      if (!(err instanceof ApiError && err.code === 'plan_tier')) toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const header = (
    <PageHeader
      eyebrow={tn('create')}
      title={t('page.title')}
      description={t('page.description')}
      actions={
        businessId ? (
          <Button asChild variant="ghost">
            <Link href="/business?tab=images">{t('page.wholeLibrary')}</Link>
          </Button>
        ) : undefined
      }
    />
  );

  if (ready && !businessId)
    return (
      <>
        {header}
        <EmptyState media="images" title={t('pickFirst.title')} description={t('pickFirst.body')} />
      </>
    );
  if (flagOff)
    return (
      <>
        {header}
        <EmptyState media="images" title={t('off.title')} description={t('off.body')} />
      </>
    );

  const images = list.data?.data ?? [];
  return (
    <>
      {header}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-4 lg:sticky lg:top-20">
          {mayWrite ? (
            <>
              {locked && <LockedNote />}
              <ImagePromptForm
                value={request}
                onChange={setRequest}
                onSubmit={() => void generate(request)}
                busy={pending !== null}
                disabled={!canGenerate}
              />
              {last && canGenerate && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {t('form.lastPrompt', { prompt: last.prompt })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => void generate(last)}
                  >
                    <RefreshCw /> {t('form.again')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p role="note" className="text-sm text-muted-foreground">
              {t('readOnly')}
            </p>
          )}
        </div>
        <section aria-labelledby="image-results-title" className="flex min-w-0 flex-col gap-4">
          <h2 id="image-results-title" className="text-base font-semibold">
            {t('results.title')}
          </h2>
          {list.error ? (
            <ErrorState error={list.error} onRetry={() => void list.mutate()} />
          ) : list.isLoading || !list.data ? (
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-3"
              aria-label={t('results.loading')}
            >
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="aspect-square rounded-lg" />
              ))}
            </div>
          ) : images.length === 0 && !pending ? (
            <EmptyState
              size="compact"
              media="images"
              title={t('results.empty.title')}
              description={t('results.empty.body')}
            />
          ) : (
            <ImageResults
              images={images}
              pending={cursors.length === 0 ? pending : null}
              onOpen={setPreview}
            />
          )}
          {(cursors.length > 0 || list.data?.nextCursor) && (
            <div className="flex justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={cursors.length === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                {t('results.newer')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!list.data?.nextCursor}
                onClick={() => {
                  const next = list.data?.nextCursor;
                  if (next) setCursors((c) => [...c, next]);
                }}
              >
                {t('results.older')}
              </Button>
            </div>
          )}
        </section>
      </div>
      <ImagePreviewDialog
        image={preview}
        onClose={() => setPreview(null)}
        canGenerate={canGenerate}
        busy={pending !== null}
        onGenerateAgain={(again) => {
          setPreview(null);
          setRequest(again);
          void generate(again);
        }}
        onEditPrompt={(edit) => {
          setPreview(null);
          setRequest(edit);
        }}
      />
    </>
  );
}
