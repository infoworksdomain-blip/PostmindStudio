'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link2, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { StateBadge } from '../primitives';
import { ConfirmDialog } from '../publications/confirm-dialog';
import type { OAUTH_PLATFORMS } from './platforms';

// One platform row: its connected accounts (with a visible needs-reconnect state), a connect
// button and per-account disconnect behind a confirmation.

type PlatformInfo = (typeof OAUTH_PLATFORMS)[number];

function AccountRow({
  connection,
  label,
  connecting,
  onReconnect,
  onDisconnect,
}: {
  connection: PlatformConnection;
  label: string;
  connecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => Promise<boolean>;
}) {
  const t = useTranslations('connections');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const stale = connection.state === 'needs_reconnect';
  const account = connection.platformAccountName;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{connection.platformAccountName}</span>
          {stale ? (
            <StateBadge label={t('needsReconnecting')} tone="warn" />
          ) : (
            <StateBadge label={t('connected')} tone="good" />
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {stale ? t('stale') : t('connectedOn', { date: f.date(connection.connectedAt) })}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {stale && (
          <Button size="sm" disabled={connecting} onClick={onReconnect}>
            {connecting ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t('reconnect')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('disconnectAria', { account })}
          onClick={() => setConfirming(true)}
        >
          <Unplug /> <span className="sr-only sm:not-sr-only">{t('disconnect')}</span>
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('disconnectConfirm.title', { account })}
        description={t('disconnectConfirm.body', { platform: label })}
        confirmLabel={t('disconnect')}
        onConfirm={onDisconnect}
      />
    </li>
  );
}

export function PlatformCard({
  platform,
  connections,
  connecting,
  onConnect,
  onDisconnect,
}: {
  platform: PlatformInfo;
  connections: PlatformConnection[];
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: (connection: PlatformConnection) => Promise<boolean>;
}) {
  const t = useTranslations('connections');
  const connected = connections.length > 0;
  return (
    <section
      aria-labelledby={`platform-${platform.id}`}
      className="grid gap-4 border-b border-border/70 py-6 md:grid-cols-[14rem_1fr]"
    >
      <div>
        <h2 id={`platform-${platform.id}`} className="font-display text-3xl leading-none">
          {platform.label}
        </h2>
        <p className="mt-1.5 text-xs text-muted-foreground">{t(`posts.${platform.id}`)}</p>
      </div>
      <div className="min-w-0">
        {connected ? (
          <ul className="divide-y divide-border/70">
            {connections.map((c) => (
              <AccountRow
                key={c.id}
                connection={c}
                label={platform.label}
                connecting={connecting}
                onReconnect={onConnect}
                onDisconnect={() => onDisconnect(c)}
              />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">{t('notConnected')}</p>
        )}
        <Button
          className="mt-2"
          variant={connected ? 'outline' : 'default'}
          disabled={connecting}
          onClick={onConnect}
        >
          {connecting ? <Loader2 className="animate-spin" /> : <Link2 />}
          {connected
            ? t('addAnother', { platform: platform.label })
            : t('connect', { platform: platform.label })}
        </Button>
      </div>
    </section>
  );
}
