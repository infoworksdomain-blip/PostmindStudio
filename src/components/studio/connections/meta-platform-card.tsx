'use client';

import { useTranslations } from 'next-intl';
import { Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import { platformState } from './connection-status';
import { AccountList, AccountRow, PlatformHeading, PlatformMark } from './platform-card';
import { META_PLATFORMS, type MetaPlatform } from './platforms';

// Instagram and Facebook, on their own card (25.12): one Meta login covers both. Two modes
// (GET /platform-connections `meta`, Phase 18 §2.10):
//   core   — PostMind Core runs the Meta login and registers these accounts with Studio, so the
//            card is read-only: connect, reconnect and disconnect all happen in PostMind settings.
//   studio — Studio's own Facebook Login for Business: one "Connect" connects the Pages the user
//            picks in Meta's dialog and the Instagram accounts linked to them; each account can be
//            reconnected or disconnected here. Until the operator configures Studio's Meta app
//            the button is replaced by a note saying so.

function MetaPlatformSection({
  id,
  label,
  connections,
  studio,
  configured,
  connecting,
  onConnect,
  onDisconnect,
}: {
  id: MetaPlatform;
  label: string;
  connections: PlatformConnection[];
  studio: boolean;
  configured: boolean;
  connecting: boolean;
  onConnect?: () => void;
  onDisconnect?: (connection: PlatformConnection) => Promise<boolean>;
}) {
  const t = useTranslations('connections');
  const f = useFormat();
  return (
    <section aria-labelledby={`platform-${id}`} className="border-t border-border py-5 last:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <PlatformMark label={label} />
        <PlatformHeading
          id={id}
          label={label}
          state={platformState(connections, !studio || configured)}
        />
      </div>
      {connections.length > 0 && (
        <AccountList>
          {connections.map((c) =>
            studio && c.connectedVia === 'studio' && onDisconnect ? (
              <AccountRow
                key={c.id}
                connection={c}
                label={label}
                connecting={connecting}
                onReconnect={onConnect}
                onDisconnect={() => onDisconnect(c)}
              />
            ) : (
              <AccountRow
                key={c.id}
                connection={c}
                label={label}
                connecting={false}
                staleText={t('meta.stale')}
                connectedText={t('meta.connectedVia', { date: f.date(c.connectedAt) })}
              />
            ),
          )}
        </AccountList>
      )}
    </section>
  );
}

export function MetaPlatformCard({
  connections,
  info,
  connecting = false,
  onConnect,
  onDisconnect,
}: {
  /** This business's Instagram and Facebook accounts. */
  connections: PlatformConnection[];
  /** Absent = core mode (pre-Phase-18 API without `meta`). */
  info?: MetaConnectInfo;
  connecting?: boolean;
  onConnect?: () => void;
  onDisconnect?: (connection: PlatformConnection) => Promise<boolean>;
}) {
  const t = useTranslations('connections');
  const studio = info?.connect === 'studio';
  const configured = studio && info.configured;
  const canConnect = configured && onConnect;
  const connected = connections.length > 0;
  return (
    <section
      aria-labelledby="platform-meta"
      className="mt-8 rounded-panel border border-border bg-card p-5 shadow-raised md:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="max-w-xl min-w-0">
          <h2 id="platform-meta" className="text-base font-semibold tracking-tight">
            {t('meta.title')}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">
            {!studio
              ? t('meta.guidance')
              : configured
                ? t('meta.studioGuidance')
                : t('meta.notConfigured')}
          </p>
        </div>
        {canConnect && (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            loading={connecting}
            onClick={onConnect}
          >
            {!connecting && <Link2 />}
            {t('meta.connectButton')}
          </Button>
        )}
      </div>
      <div className="mt-2">
        {META_PLATFORMS.map((p) => (
          <MetaPlatformSection
            key={p.id}
            id={p.id}
            label={p.label}
            connections={connections.filter((c) => c.platform === p.id)}
            studio={studio}
            configured={configured}
            connecting={connecting}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </section>
  );
}
