'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApiError, errorMessage, useApi } from '@/lib/client/api';
import { useBusiness } from '../business-context';
import { VideoRow } from './video-row';
import type { LibraryVideoSummary, ListResponse } from './types';

// A3.5 operation 2 — "videos we recommend for your business": nearest to the selected
// business's profile (GET /library/recommended?businessId=&category=).

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function RecommendedShelf({ category }: { category: string }) {
  const { businessId, ready } = useBusiness();
  const { data, error, isLoading } = useApi<ListResponse<LibraryVideoSummary>>(
    businessId ? '/library/recommended' : null,
    { businessId, category: category || undefined, limit: 12 },
  );

  let body: ReactNode;
  if (!ready) body = null;
  else if (!businessId)
    body = <Note>Pick a business in the top bar to see references matched to it.</Note>;
  else if (error instanceof ApiError && error.status === 404)
    body = (
      <Note>
        No business profile yet — recommendations need a website scan.{' '}
        <Link href="/business" className="font-medium text-foreground underline">
          Scan your site
        </Link>
      </Note>
    );
  else if (error) body = <Note>Recommendations are unavailable: {errorMessage(error)}</Note>;
  else
    body = (
      <VideoRow
        label="Recommended for your business"
        videos={data?.data}
        isLoading={isLoading}
        empty={<Note>No close matches in this category yet.</Note>}
      />
    );

  return (
    <section aria-labelledby="library-recommended" className="mb-10 min-w-0">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 id="library-recommended" className="font-display text-2xl">
          Picked for your business
        </h2>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Matched to your business profile
        </p>
      </div>
      {body}
    </section>
  );
}
