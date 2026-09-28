'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';

// BACKLOG 17.3 — "Access checked <date>" under a connected account, once the daily
// account-status check has confirmed the platform still accepts its token. An `unreachable`
// check (the platform could not be reached) changes nothing and shows nothing.

export function CheckedLine({ connection }: { connection: PlatformConnection }) {
  const t = useTranslations('connections');
  const f = useFormat();
  if (connection.statusCheckOutcome !== 'ok' || !connection.statusCheckedAt) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t('checkedOn', { date: f.date(connection.statusCheckedAt) })}
    </p>
  );
}
