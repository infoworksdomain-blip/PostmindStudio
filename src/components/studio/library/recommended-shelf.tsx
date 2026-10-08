'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, useApi, useErrorMessage } from '@/lib/client/api';
import { useBusiness } from '../business-context';
import { VideoRow } from './video-row';
import type { LibraryVideoSummary, ListResponse } from './types';

// A3.5 operation 2 — "videos we recommend for your business": nearest to the selected
// business's profile (GET /library/recommended?businessId=&category=).

function Note({ children }: { children: ReactNode }) {
  return <p className="border-t border-border py-4 text-sm text-muted-foreground">{children}</p>;
}

export function RecommendedShelf({ category }: { category: string }) {
  const t = useTranslations('library.recommended');
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const { data, error, isLoading } = useApi<ListResponse<LibraryVideoSummary>>(
    businessId ? '/library/recommended' : null,
    { businessId, category: category || undefined, limit: 12 },
  );

  let body: ReactNode;
  if (!ready) body = null;
  else if (!businessId) body = <Note>{t('pickBusiness')}</Note>;
  else if (error instanceof ApiError && error.status === 404)
    body = (
      <Note>
        {t.rich('noProfile', {
          link: (chunks) => (
            <Link href="/business" className="font-medium text-foreground underline">
              {chunks}
            </Link>
          ),
        })}
      </Note>
    );
  else if (error) body = <Note>{t('unavailable', { error: errorMessage(error) })}</Note>;
  else
    body = (
      <VideoRow
        label={t('listAria')}
        loadingLabel={t('loading')}
        videos={data?.data}
        isLoading={isLoading}
        empty={<Note>{t('empty')}</Note>}
      />
    );

  return (
    <section aria-labelledby="library-recommended" className="mb-rhythm-section min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="library-recommended" className="text-lg font-semibold tracking-tight">
          {t('heading')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('subheading')}</p>
      </div>
      {body}
    </section>
  );
}
