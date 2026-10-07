'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import type { PlatformConnection } from '@/lib/client/types';
import {
  belongsToBusiness,
  META_PLATFORMS,
  OAUTH_PLATFORMS,
  platformLabel,
} from '../connections/platforms';
import { ErrorState } from '../primitives';

// Step 2 (Channels) — connect the accounts Studio publishes to. OAuth lives on the Connections
// screen; this step shows every platform with its connection state for the business and links
// there. 25.6: one clean list, each row a platform, its account(s) and a status pill.

// TikTok and YouTube, then Instagram and Facebook, then X and LinkedIn.
const PLATFORMS = [...OAUTH_PLATFORMS.slice(0, 2), ...META_PLATFORMS, ...OAUTH_PLATFORMS.slice(2)];

type RowState = 'connected' | 'needsReconnecting' | 'notConnected';

const TONE: Record<RowState, StatusTone> = {
  connected: 'good',
  needsReconnecting: 'warn',
  notConnected: 'neutral',
};

function rowState(connections: PlatformConnection[]): RowState {
  if (connections.some((c) => c.state === 'active')) return 'connected';
  if (connections.some((c) => c.state === 'needs_reconnect')) return 'needsReconnecting';
  return 'notConnected';
}

export function ConnectStep({
  businessId,
  onReady,
}: {
  businessId: string;
  onReady: (ready: boolean) => void;
}) {
  const t = useTranslations('onboarding.connect');
  const tc = useTranslations('connections');
  const { data, error, mutate } = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const mine = (data?.data ?? []).filter((c) => belongsToBusiness(c, businessId));
  const count = mine.filter((c) => c.state === 'active').length;
  useEffect(() => onReady(count > 0), [count, onReady]);

  const stateLabel: Record<RowState, string> = {
    connected: tc('connected'),
    needsReconnecting: tc('needsReconnecting'),
    notConnected: t('notConnected'),
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-2xl leading-tight sm:text-[1.75rem]">{t('title')}</h2>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-foreground-secondary">
          {t('description')}
        </p>
      </div>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {!data && !error && <Skeleton className="h-72 rounded-panel" aria-label={t('loading')} />}
      {data && (
        <ul
          aria-label={t('connectedAria')}
          className="divide-y divide-border overflow-hidden rounded-panel border border-border"
        >
          {PLATFORMS.map((platform) => {
            const accounts = mine.filter(
              (c) => c.platform === platform.id && c.state !== 'revoked',
            );
            const state = rowState(accounts);
            return (
              <li key={platform.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{platformLabel(platform.id)}</p>
                  <p className="truncate text-xs text-foreground-secondary">
                    {accounts.length > 0 ? (
                      <bdi>{accounts.map((c) => c.platformAccountName).join(', ')}</bdi>
                    ) : (
                      tc(`posts.${platform.id}`)
                    )}
                  </p>
                </div>
                <StatusPill tone={TONE[state]} dot={state !== 'notConnected'} size="sm">
                  {stateLabel[state]}
                </StatusPill>
              </li>
            );
          })}
        </ul>
      )}
      {data && count === 0 && <p className="text-sm text-foreground-secondary">{t('none')}</p>}
      <div>
        <Button asChild variant="outline">
          <Link href="/connections">
            {count > 0 ? t('connectAnother') : t('openConnections')}
            <ArrowUpRight aria-hidden className="rtl:-scale-x-100" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
