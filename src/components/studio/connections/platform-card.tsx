'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link2, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { CheckedLine } from './checked-line';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { platformState, STATE_TONE, type PlatformState } from './connection-status';
import type { OAUTH_PLATFORMS } from './platforms';
import { TikTokPostModeSetting } from './tiktok-post-mode';

// BACKLOG 25.12 — one platform in the Connections list: its mark, name, what Studio does there
// and one connection state, the primary action, then its accounts (each with when it was
// connected or why it stopped working, Reconnect and Disconnect behind a confirmation).

type PlatformInfo = (typeof OAUTH_PLATFORMS)[number];

/** A quiet monogram: no third-party logos, the name beside it carries the meaning. */
export function PlatformMark({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-field bg-surface-raised text-sm font-semibold text-foreground-secondary"
    >
      {label.charAt(0)}
    </span>
  );
}

/** The heading block of a platform: name, state pill and what Studio can do there. */
export function PlatformHeading({
  id,
  label,
  state,
  children,
}: {
  id: PlatformConnection['platform'];
  label: string;
  state: PlatformState;
  children?: ReactNode;
}) {
  const t = useTranslations('connections');
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`platform-${id}`} className="text-base font-semibold tracking-tight">
          {label}
        </h2>
        <StatusPill tone={STATE_TONE[state]} dot>
          {t(`state.${state}`)}
        </StatusPill>
      </div>
      <p className="mt-0.5 text-sm text-foreground-secondary">{t(`posts.${id}`)}</p>
      {children}
    </div>
  );
}

export function AccountRow({
  connection,
  label,
  connecting,
  canReconnect = true,
  staleText,
  connectedText,
  onReconnect,
  onDisconnect,
  onSettingsChanged,
}: {
  connection: PlatformConnection;
  label: string;
  connecting: boolean;
  /** False while the platform's app is not set up: a Reconnect would only fail. */
  canReconnect?: boolean;
  /** Overrides why a stale account stopped working (Meta's own wording). */
  staleText?: string;
  /** Overrides "Connected <date>" (an account registered by PostMind). */
  connectedText?: string;
  onReconnect?: () => void;
  /** Absent: the account is read-only here (managed in PostMind). */
  onDisconnect?: () => Promise<boolean>;
  /** 22.7: refresh after a setting changed (TikTok posting preference); absent = no settings. */
  onSettingsChanged?: () => void | Promise<unknown>;
}) {
  const t = useTranslations('connections');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const stale = connection.state === 'needs_reconnect';
  const account = connection.platformAccountName;
  return (
    <li className="grid gap-2 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{account}</p>
          {stale ? (
            <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-warning-foreground">
              {staleText ?? t('stale')}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {connectedText ?? t('connectedOn', { date: f.date(connection.connectedAt) })}
            </p>
          )}
          {!stale && <CheckedLine connection={connection} />}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {stale && canReconnect && onReconnect && (
            <Button size="sm" loading={connecting} onClick={onReconnect}>
              {!connecting && <RefreshCw />} {t('reconnect')}
            </Button>
          )}
          {onDisconnect && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('disconnectAria', { account })}
              onClick={() => setConfirming(true)}
            >
              <Unplug /> <span className="sr-only sm:not-sr-only">{t('disconnect')}</span>
            </Button>
          )}
        </div>
      </div>
      {connection.platform === 'tiktok' && onSettingsChanged && (
        <TikTokPostModeSetting connection={connection} onChanged={onSettingsChanged} />
      )}
      {onDisconnect && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('disconnectConfirm.title', { account })}
          description={t('disconnectConfirm.body', { platform: label })}
          confirmLabel={t('disconnect')}
          onConfirm={onDisconnect}
        />
      )}
    </li>
  );
}

/** The accounts under a platform, indented to line up with its name. */
export function AccountList({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-3 divide-y divide-border border-t border-border sm:ms-14">{children}</ul>
  );
}

export function PlatformCard({
  platform,
  connections,
  connecting,
  configured = true,
  onConnect,
  onDisconnect,
  onSettingsChanged,
}: {
  platform: PlatformInfo;
  connections: PlatformConnection[];
  connecting: boolean;
  /** 20.10: false while the operator has not set this platform's app (no Connect button). */
  configured?: boolean;
  onConnect: () => void;
  onDisconnect: (connection: PlatformConnection) => Promise<boolean>;
  onSettingsChanged?: () => void | Promise<unknown>;
}) {
  const t = useTranslations('connections');
  const connected = connections.length > 0;
  const state = platformState(connections, configured);
  return (
    <section aria-labelledby={`platform-${platform.id}`} className="border-b border-border py-5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <PlatformMark label={platform.label} />
        <PlatformHeading id={platform.id} label={platform.label} state={state}>
          {!configured && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t('notConfigured', { platform: platform.label })}
            </p>
          )}
        </PlatformHeading>
        {configured && (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            loading={connecting}
            onClick={onConnect}
          >
            {!connecting && <Link2 />}
            {connected
              ? t('addAnother', { platform: platform.label })
              : t('connect', { platform: platform.label })}
          </Button>
        )}
      </div>
      {connected && (
        <AccountList>
          {connections.map((c) => (
            <AccountRow
              key={c.id}
              connection={c}
              label={platform.label}
              connecting={connecting}
              canReconnect={configured}
              onReconnect={onConnect}
              onDisconnect={() => onDisconnect(c)}
              onSettingsChanged={onSettingsChanged}
            />
          ))}
        </AccountList>
      )}
    </section>
  );
}
