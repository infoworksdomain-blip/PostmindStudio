'use client';

import { useTranslations } from 'next-intl';
import { Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import { StateBadge } from '../primitives';
import { CheckedLine } from './checked-line';
import { AccountRow } from './platform-card';
import type { META_PLATFORMS } from './platforms';

// Instagram / Facebook row. Two modes (GET /platform-connections `meta`, Phase 18 §2.10):
//   core   — PostMind Core runs the Meta login and registers these accounts with Studio, so the
//            row is read-only: connect, reconnect and disconnect all happen in PostMind settings.
//   studio — Studio's own Facebook Login for Business: one "Connect" connects the Pages the user
//            picks in Meta's dialog and the Instagram accounts linked to them; each account can be
//            reconnected or disconnected here. Until the operator configures Studio's Meta app
//            the button is replaced by a note saying so.

type MetaPlatformInfo = (typeof META_PLATFORMS)[number];

function CoreAccountRow({ connection }: { connection: PlatformConnection }) {
  const t = useTranslations('connections');
  const f = useFormat();
  const stale = connection.state === 'needs_reconnect';
  return (
    <li className="py-3">
      <p className="flex flex-wrap items-center gap-2">
        <span className="truncate font-medium">{connection.platformAccountName}</span>
        {stale ? (
          <StateBadge label={t('needsReconnecting')} tone="warn" />
        ) : (
          <StateBadge label={t('connected')} tone="good" />
        )}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {stale ? t('meta.stale') : t('meta.connectedVia', { date: f.date(connection.connectedAt) })}
      </p>
      {!stale && <CheckedLine connection={connection} />}
    </li>
  );
}

export function MetaPlatformCard({
  platform,
  connections,
  info,
  connecting = false,
  onConnect,
  onDisconnect,
}: {
  platform: MetaPlatformInfo;
  connections: PlatformConnection[];
  /** Absent = core mode (pre-Phase-18 API without `meta`). */
  info?: MetaConnectInfo;
  connecting?: boolean;
  onConnect?: () => void;
  onDisconnect?: (connection: PlatformConnection) => Promise<boolean>;
}) {
  const t = useTranslations('connections');
  const studio = info?.connect === 'studio';
  const canConnect = studio && info.configured && onConnect;
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
        {connections.length > 0 ? (
          <ul className="divide-y divide-border/70">
            {connections.map((c) =>
              studio && c.connectedVia === 'studio' && onDisconnect ? (
                <AccountRow
                  key={c.id}
                  connection={c}
                  label={platform.label}
                  connecting={connecting}
                  onReconnect={() => onConnect?.()}
                  onDisconnect={() => onDisconnect(c)}
                />
              ) : (
                <CoreAccountRow key={c.id} connection={c} />
              ),
            )}
          </ul>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">{t('notConnected')}</p>
        )}
        {canConnect && (
          <Button
            className="mt-2"
            variant={connections.length > 0 ? 'outline' : 'default'}
            disabled={connecting}
            onClick={onConnect}
          >
            {connecting ? <Loader2 className="animate-spin" /> : <Link2 />}
            {t('meta.connectButton')}
          </Button>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          {!studio
            ? t('meta.guidance')
            : info.configured
              ? t('meta.studioGuidance')
              : t('meta.notConfigured')}
        </p>
      </div>
    </section>
  );
}
