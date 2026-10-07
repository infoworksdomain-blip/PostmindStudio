'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { MediaItemTile } from './media-item-tile';
import { resolveFilter, TYPE_PARAM, withFilter } from './media-model';
import { MediaPreviewDialog } from './media-preview-dialog';
import { MEDIA_FILTERS, type MediaFilter, type MediaItem, type MediaPage } from './types';

// BACKLOG 25.10 — My media: what the business already has, in one place — finished videos
// (renders of its projects), the videos it uploaded and its image library — from
// GET /media (services/media.ts), newest first, with cursor pages. The segment (All, Videos,
// Images, Uploads) lives in ?type=. Scoped to the business picked in the top bar, or every
// business when none is picked. Uploading stays where it already happens: Create (your own video)
// and Business & images (photos); nothing is uploaded from here.

const PAGE_SIZE = 24;
const GRID =
  'grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';

function useFilterParam(): [MediaFilter, (next: MediaFilter) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params?.get(TYPE_PARAM) ?? null;
  const [chosen, setChosen] = useState<{ value: MediaFilter; over: string | null } | null>(null);
  const filter = chosen && chosen.over === fromUrl ? chosen.value : resolveFilter(fromUrl);
  const set = (next: MediaFilter) => {
    setChosen({ value: next, over: fromUrl });
    router.replace(`${pathname ?? '/media'}${withFilter(params?.toString() ?? '', next)}`, {
      scroll: false,
    });
  };
  return [filter, set];
}

function UploadActions() {
  const t = useTranslations('media.actions');
  return (
    <>
      <Button asChild variant="secondary">
        <Link href="/new">
          <Upload /> {t('uploadVideo')}
        </Link>
      </Button>
      <Button asChild variant="ghost">
        <Link href="/business?tab=images">
          <ImagePlus /> {t('addImages')}
        </Link>
      </Button>
    </>
  );
}

export function MediaScreen() {
  const t = useTranslations('media');
  const tn = useTranslations('shell.nav.groups');
  const tc = useTranslations('common.actions');
  const f = useFormat();
  const { businessId, ready } = useBusiness();
  const [filter, setFilter] = useFilterParam();
  const scope = `${filter}|${businessId ?? ''}`;
  const [pages, setPages] = useState<{ scope: string; cursors: string[] }>({
    scope,
    cursors: [],
  });
  const cursors = pages.scope === scope ? pages.cursors : [];
  const [open, setOpen] = useState<MediaItem | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const { data, error, isLoading, mutate } = useApi<MediaPage>(ready ? '/media' : null, {
    type: filter === 'all' ? undefined : filter,
    businessId: businessId ?? undefined,
    cursor: cursors.at(-1),
    limit: PAGE_SIZE,
  });
  const items = data?.data ?? [];
  const paged = cursors.length > 0 || Boolean(data?.nextCursor);

  return (
    <>
      <PageHeader
        eyebrow={tn('library')}
        title={t('page.title')}
        description={t('page.description')}
        actions={<UploadActions />}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <SegmentedControl
          label={t('filters.label')}
          options={MEDIA_FILTERS.map((value) => ({ value, label: t(`filters.${value}`) }))}
          value={filter}
          onChange={setFilter}
        />
        {ready && (
          <p className="text-sm text-muted-foreground">
            {businessId ? t('scope.business') : t('scope.all')}
          </p>
        )}
      </div>

      <section aria-label={t('grid.aria')} className="min-w-0 border-t border-border pt-6">
        {error && <ErrorState error={error} onRetry={() => void mutate()} />}
        {(!ready || isLoading) && !error && (
          <div aria-label={t('grid.loading')} className={GRID}>
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="aspect-[4/5] rounded-lg" />
            ))}
          </div>
        )}
        {data && items.length === 0 && (
          <EmptyState
            media="library"
            title={t(`empty.${filter}.title`)}
            description={t(`empty.${filter}.body`)}
            action={filter === 'video' ? undefined : <UploadActions />}
          />
        )}
        {data && items.length > 0 && (
          <ul className={GRID}>
            {items.map((item) => (
              <li key={`${item.type}:${item.id}`} className="min-w-0">
                <MediaItemTile
                  item={item}
                  onOpen={() => {
                    opener.current =
                      document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    setOpen(item);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {data && paged && (
          <nav
            aria-label={t('grid.pagesAria')}
            className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-4"
          >
            <Button
              variant="ghost"
              disabled={cursors.length === 0}
              onClick={() => setPages({ scope, cursors: cursors.slice(0, -1) })}
            >
              <ChevronLeft className="rtl:-scale-x-100" /> {tc('previous')}
            </Button>
            <span className="font-mono text-xs text-muted-foreground">
              {t('grid.page', { page: f.number(cursors.length + 1) })}
            </span>
            <Button
              variant="secondary"
              disabled={!data.nextCursor}
              onClick={() =>
                data.nextCursor && setPages({ scope, cursors: [...cursors, data.nextCursor] })
              }
            >
              {t('grid.more')} <ChevronRight className="rtl:-scale-x-100" />
            </Button>
          </nav>
        )}
      </section>

      <MediaPreviewDialog item={open} onClose={() => setOpen(null)} returnFocusTo={opener} />
    </>
  );
}
