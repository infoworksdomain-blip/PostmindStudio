'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { CheckCircle2, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import type { PlatformConnection } from '@/lib/client/types';
import { belongsToBusiness, platformLabel } from '../connections/platforms';
import { ErrorState } from '../primitives';

// Step 1 — connect the accounts Studio publishes to. OAuth lives on the Connections screen;
// this step lists what is already connected for the business and links there.

export function ConnectStep({
  businessId,
  onReady,
}: {
  businessId: string;
  onReady: (ready: boolean) => void;
}) {
  const { data, error, mutate } = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const live = (data?.data ?? []).filter(
    (c) => belongsToBusiness(c, businessId) && c.state === 'active',
  );
  const count = live.length;
  useEffect(() => onReady(count > 0), [count, onReady]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-3xl">Connect where you post</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Studio publishes straight to TikTok, YouTube, Instagram, Facebook, X and LinkedIn. Connect
          at least one account so your first video can go live.
        </p>
      </div>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {!data && !error && <Skeleton className="h-16 rounded-xl" aria-label="Loading accounts" />}
      {data && count > 0 && (
        <ul aria-label="Connected accounts" className="flex flex-col gap-2">
          {live.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <CheckCircle2 className="size-4 text-success" />
              <span className="font-medium">{platformLabel(c.platform)}</span>
              <span className="text-muted-foreground">{c.platformAccountName}</span>
            </li>
          ))}
        </ul>
      )}
      {data && count === 0 && (
        <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
      )}
      <div>
        <Button asChild variant="outline">
          <Link href="/connections">
            <Link2 /> {count > 0 ? 'Connect another account' : 'Open Connections'}
          </Link>
        </Button>
      </div>
    </div>
  );
}
