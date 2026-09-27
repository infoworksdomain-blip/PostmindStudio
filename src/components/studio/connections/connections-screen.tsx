'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Link2, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { PlatformConnection } from '@/lib/client/types';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { PlatformCard } from './platform-card';
import {
  callbackErrorMessage,
  OAUTH_PLATFORMS,
  platformLabel,
  type OAuthPlatform,
} from './platforms';

// Connections (spec 8.6, 14.5): connect TikTok / YouTube / X / LinkedIn for the selected
// business. Connect → POST oauth-init → browser goes to the platform → the OAuth callback
// redirects back here with ?connected=<platform> or ?connection_error=<code>.

type Notice = { tone: 'good' | 'bad'; text: string };

function useCallbackNotice(): [Notice | null, () => void] {
  const params = useSearchParams();
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const handled = useRef<string | null>(null);
  const connected = params?.get('connected');
  const failed = params?.get('connection_error') ?? params?.get('error');

  useEffect(() => {
    if (!connected && !failed) return;
    // Handle each callback result once, however often the router identity changes.
    const key = `${connected ?? ''}|${failed ?? ''}`;
    if (handled.current === key) return;
    handled.current = key;
    const next: Notice = connected
      ? {
          tone: 'good',
          text: `${platformLabel(connected)} is connected. You can publish to it now.`,
        }
      : { tone: 'bad', text: callbackErrorMessage(failed as string) };
    setNotice(next);
    if (next.tone === 'good') toast.success(next.text);
    else toast.error(next.text);
    // Drop the query so a refresh does not replay the message.
    router.replace('/connections', { scroll: false });
  }, [connected, failed, router]);

  return [notice, () => setNotice(null)];
}

function goTo(url: string) {
  window.location.assign(url);
}

export function ConnectionsScreen({ navigate = goTo }: { navigate?: (url: string) => void }) {
  const { businessId, ready } = useBusiness();
  const { data, error, isLoading, mutate } = useApi<{ data: PlatformConnection[] }>(
    businessId ? '/platform-connections' : null,
  );
  const [connecting, setConnecting] = useState<OAuthPlatform | null>(null);
  const [notice, dismiss] = useCallbackNotice();

  async function connect(platform: OAuthPlatform) {
    if (!businessId) return;
    setConnecting(platform);
    try {
      const res = await api<{ authorizeUrl: string }>('/platform-connections/oauth-init', {
        method: 'POST',
        body: { platform, businessId, returnTo: `${window.location.origin}/connections` },
        idempotencyKey: newIdempotencyKey(),
      });
      navigate(res.authorizeUrl);
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
      toast.success(`${connection.platformAccountName} disconnected`);
      await mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  // The list endpoint is organisation-wide; show this business's live (non-revoked) accounts.
  const mine = (data?.data ?? []).filter(
    (c) => c.businessId === businessId && c.state !== 'revoked',
  );

  return (
    <>
      <PageHeader
        eyebrow="Set up"
        title="Connections"
        description="The accounts Studio publishes to. Instagram and Facebook use your PostMind Engagement connection."
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
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss}>
            <X />
          </Button>
        </div>
      )}
      {ready && !businessId && (
        <EmptyState
          icon={<Link2 className="size-8" strokeWidth={1.5} />}
          title="Pick a business first"
          description="Connections belong to a business. Choose one in the top bar."
        />
      )}
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {businessId && isLoading && (
        <div className="flex flex-col gap-3" aria-label="Loading connections">
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
        </div>
      )}
    </>
  );
}
