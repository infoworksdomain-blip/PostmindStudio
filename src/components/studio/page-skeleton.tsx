'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

// BACKLOG 25.4 — what a (studio) page shows while it loads: the shape of a page header and a few
// rows inside the app shell (the sidebar and top bar stay), never a full-page spinner. Used by
// app/(studio)/loading.tsx and as the Suspense fallback of pages that read the URL.

export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  const t = useTranslations('common.states');
  return (
    <div aria-busy="true" className="grid gap-8">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      <div className="grid max-w-xl gap-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full" />
      </div>
      <div className="grid gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-field" />
        ))}
      </div>
    </div>
  );
}
