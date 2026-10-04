'use client';

import Link from 'next/link';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { channelList } from '../billing/channel-labels';
import { useMe } from '../account/use-me';

// Phase 21.5 — connecting is never blocked, but only the channels the organisation pays for
// publish (the platforms connected first; billing/channels.ts). When more platforms are connected
// than paid channels, Connections says which ones will not publish and links to Your plan to add
// a channel: an upgrade prompt, not an error. Nothing renders without a channel plan.

export function ChannelLimitNotice() {
  const t = useTranslations('connections.channelLimit');
  const channels = useMe().data?.me?.channels;
  if (!channels || channels.blocked.length === 0) return null;
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-3 rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {t('body', {
          count: channels.paid,
          blocked: channelList(channels.blocked),
          blockedCount: channels.blocked.length,
        })}
      </p>
      <Link
        href="/settings/billing#change"
        className="font-medium whitespace-nowrap underline underline-offset-4 hover:no-underline"
      >
        {t('action')}
      </Link>
    </div>
  );
}
