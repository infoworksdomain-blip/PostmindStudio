'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import { hardNavigate } from '@/lib/client/navigate';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { MetaPlatformCard } from './meta-platform-card';
import { PlatformCard } from './platform-card';
import { ByocKeysPanel } from '../settings/byoc-keys-panel';
import {
  belongsToBusiness,
  callbackErrorCode,
  META_PLATFORMS,
  OAUTH_PLATFORMS,
  platformLabel,
  type ConnectPlatform,
} from './platforms';

// Connections (spec 8.6, 14.5): connect TikTok / YouTube / X / LinkedIn for the selected
// business. Connect → POST oauth-init → browser goes to the platform → the OAuth callback
// redirects back here with ?connected=<platform> or ?connection_error=<code>. Instagram and
// Facebook: in core mode they are connected in PostMind settings and listed here read-only; in
// standalone mode (Phase 18 §2.10) "Connect" runs Studio's own Meta login (?connected=meta&count=N).

type Notice = { tone: 'good' | 'bad'; text: string };

function useCallbackNotice(): [Notice | null, () => void] {
  const t = useTranslations('connections');
  const params = useSearchParams();
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const handled = useRef<string | null>(null);
  const connected = params?.get('connected');
  const count = Number(params?.get('count') ?? 0);
  const failed = params?.get('connection_error') ?? params?.get('error');

  useEffect(() => {
    if (!connected && !failed) return;
    // Handle each callback result once, however often the router identity changes.
    const key = `${connected ?? ''}|${failed ?? ''}`;
    if (handled.current === key) return;
    handled.current = key;
    const code = callbackErrorCode(failed ?? '');
    const next: Notice = connected
      ? {
          tone: 'good',
          text:
            connected === 'meta'
              ? t('connectedMetaNotice', { count })
              : t('connectedNotice', { platform: platformLabel(connected) }),
        }
      : {
          tone: 'bad',
          text: code
            ? t(`callbackErrors.${code}`)
            : t('callbackErrors.unknown', { code: failed ?? '' }),
        };
    setNotice(next);
    if (next.tone === 'good') toast.success(next.text);
    else toast.error(next.text);
    // Drop the query so a refresh does not replay the message.
    router.replace('/connections', { scroll: false });
  }, [connected, count, failed, router, t]);

  return [notice, () => setNotice(null)];
}

function goTo(url: string): boolean {
  return hardNavigate(url);
}

export function ConnectionsScreen({
  navigate = goTo,
}: {
  /** Follows the authorisation URL; false when the page stays (the demo), to stop the spinner. */
  navigate?: (url: string) => boolean | void;
}) {
  const t = useTranslations('connections');
  const tn = useTranslations('shell.nav.groups');
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const { data, error, isLoading, mutate } = useApi<{
    data: PlatformConnection[];
    meta?: MetaConnectInfo;
  }>(businessId ? '/platform-connections' : null);
  const [connecting, setConnecting] = useState<ConnectPlatform | null>(null);
  const [notice, dismiss] = useCallbackNotice();
  const metaInfo = data?.meta;

  async function connect(platform: ConnectPlatform) {
    if (!businessId) return;
    setConnecting(platform);
    try {
      const res = await api<{ authorizeUrl: string }>('/platform-connections/oauth-init', {
        method: 'POST',
        body: { platform, businessId, returnTo: `${window.location.origin}/connections` },
        idempotencyKey: newIdempotencyKey(),
      });
      if (navigate(res.authorizeUrl) === false) setConnecting(null);
    } catch (err) {
      toast.error(errorMessage(err));
      setConnecting(null);
    }
  }

  async function disconnect(connection: PlatformConnection): Promise<boolean> {
    try {
      await api(`/platform-connections/${connection.id}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('disconnected', { account: connection.platformAccountName }));
      await mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  // The list endpoint is organisation-wide; show this business's live (non-revoked) accounts
  // (Meta channels registered without a business apply to every business).
  const mine = (data?.data ?? []).filter(
    (c) => belongsToBusiness(c, businessId) && c.state !== 'revoked',
  );

  return (
    <>
      <PageHeader
        eyebrow={tn('setup')}
        title={t('title')}
        description={metaInfo?.connect === 'studio' ? t('descriptionStandalone') : t('description')}
      />
      {notice && (
        <div
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          className={
            notice.tone === 'good'
              ? 'mb-6 flex items-start gap-3 rounded-xl border border-success/30 bg-success/8 p-4 text-sm'
              : 'mb-6 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm'
          }
        >
          {notice.tone === 'good' ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <p className="flex-1">{notice.text}</p>
          <Button variant="ghost" size="icon-xs" aria-label={t('dismiss')} onClick={dismiss}>
            <X />
          </Button>
        </div>
      )}
      {ready && !businessId && (
        <EmptyState
          illustration="connections"
          title={t('pickFirst.title')}
          description={t('pickFirst.body')}
        />
      )}
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {businessId && isLoading && (
        <div className="flex flex-col gap-3" aria-label={t('loading')}>
          {OAUTH_PLATFORMS.map((p) => (
            <Skeleton key={p.id} className="h-24 rounded-xl" />
          ))}
        </div>
      )}
      {businessId && data && (
        <div className="border-t border-border/70">
          {OAUTH_PLATFORMS.map((p) => (
            <PlatformCard
              key={p.id}
              platform={p}
              connections={mine.filter((c) => c.platform === p.id)}
              connecting={connecting === p.id}
              onConnect={() => void connect(p.id)}
              onDisconnect={disconnect}
            />
          ))}
          {META_PLATFORMS.map((p) => (
            <MetaPlatformCard
              key={p.id}
              platform={p}
              info={metaInfo}
              connections={mine.filter((c) => c.platform === p.id)}
              connecting={connecting === 'meta'}
              onConnect={() => void connect('meta')}
              onDisconnect={disconnect}
            />
          ))}
        </div>
      )}
      <ByocKeysPanel />
    </>
  );
}
