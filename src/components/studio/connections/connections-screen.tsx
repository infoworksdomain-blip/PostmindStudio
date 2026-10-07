'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, TriangleAlert, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import { hardNavigate } from '@/lib/client/navigate';
import { StudioCapability } from '@/lib/rbac';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { ChannelLimitNotice } from './channel-limit-notice';
import { MetaPlatformCard } from './meta-platform-card';
import { PlatformCard } from './platform-card';
import { useCan } from '../use-can';
import { WriteGate } from '../write-gate';
import {
  belongsToBusiness,
  callbackErrorCode,
  isMetaPlatform,
  OAUTH_PLATFORMS,
  platformLabel,
  type ConnectPlatform,
} from './platforms';

// Connections (spec 8.6, 14.5; 25.12 Settings → Social accounts): connect TikTok / YouTube / X / LinkedIn for the selected
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
  const tn = useTranslations('settingsNav');
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const { data, error, isLoading, mutate } = useApi<{
    data: PlatformConnection[];
    meta?: MetaConnectInfo;
    /** 20.10: per OAuth platform, whether its app is configured (absent = configured). */
    configured?: Partial<Record<string, boolean>>;
  }>(businessId ? '/platform-connections' : null);
  const [connecting, setConnecting] = useState<ConnectPlatform | null>(null);
  const [notice, dismiss] = useCallbackNotice();
  const metaInfo = data?.meta;
  const mayManage = useCan(StudioCapability.ConnectionsManage);

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
        eyebrow={tn('title')}
        title={tn('items.connections')}
        description={metaInfo?.connect === 'studio' ? t('descriptionStandalone') : t('description')}
      />
      <ChannelLimitNotice />
      {notice && (
        <div
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          // 25.6: the calm notice pattern of the sign-in screens: a soft tonal wash, the tone's
          // text-safe foreground, the message, and a dismiss.
          className={
            notice.tone === 'good'
              ? 'mb-6 flex items-start gap-2.5 rounded-field bg-success-soft py-2.5 ps-3.5 pe-2 text-sm text-success-foreground'
              : 'mb-6 flex items-start gap-2.5 rounded-field bg-destructive-soft py-2.5 ps-3.5 pe-2 text-sm text-destructive-foreground'
          }
        >
          {notice.tone === 'good' ? (
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          ) : (
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          )}
          <p className="flex-1 py-px leading-relaxed">{notice.text}</p>
          <IconButton size="icon-xs" label={t('dismiss')} onClick={dismiss}>
            <X />
          </IconButton>
        </div>
      )}
      {ready && !businessId && (
        <EmptyState
          media="connections"
          title={t('pickFirst.title')}
          description={t('pickFirst.body')}
        />
      )}
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {businessId && isLoading && (
        <div className="flex flex-col gap-3" aria-label={t('loading')}>
          {OAUTH_PLATFORMS.map((p) => (
            <Skeleton key={p.id} className="h-16 rounded-field" />
          ))}
        </div>
      )}
      {businessId && data && !mayManage && (
        <p role="note" className="mb-4 text-sm text-muted-foreground">
          {t('readOnly')}
        </p>
      )}
      {businessId && data && (
        <WriteGate capability={StudioCapability.ConnectionsManage}>
          <div className="border-t border-border">
            {OAUTH_PLATFORMS.map((p) => (
              <PlatformCard
                key={p.id}
                platform={p}
                connections={mine.filter((c) => c.platform === p.id)}
                connecting={connecting === p.id}
                configured={data.configured?.[p.id] ?? true}
                onConnect={() => void connect(p.id)}
                onDisconnect={disconnect}
                // 22.7: only members who manage connections see the TikTok posting setting.
                onSettingsChanged={mayManage ? () => mutate() : undefined}
              />
            ))}
            <MetaPlatformCard
              info={metaInfo}
              connections={mine.filter((c) => isMetaPlatform(c.platform))}
              connecting={connecting === 'meta'}
              onConnect={() => void connect('meta')}
              onDisconnect={disconnect}
            />
          </div>
        </WriteGate>
      )}
    </>
  );
}
