'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { StateBadge } from '../primitives';
import type { META_PLATFORMS } from './platforms';

// Instagram / Facebook row: read-only. PostMind Core runs the Meta login and registers these
// accounts with Studio, so connect, reconnect and disconnect all happen in PostMind settings.

type MetaPlatformInfo = (typeof META_PLATFORMS)[number];

function MetaAccountRow({ connection }: { connection: PlatformConnection }) {
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
    </li>
  );
}

export function MetaPlatformCard({
  platform,
  connections,
}: {
  platform: MetaPlatformInfo;
  connections: PlatformConnection[];
}) {
  const t = useTranslations('connections');
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
            {connections.map((c) => (
              <MetaAccountRow key={c.id} connection={c} />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">{t('notConnected')}</p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">{t('meta.guidance')}</p>
      </div>
    </section>
  );
}
