'use client';

import { ExternalLink, Loader2, RotateCw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { FailureReason } from '../failure-reason';
import { StateBadge } from '../primitives';
import {
  TikTokPublicationNote,
  tiktokInboxKind,
  usePublicationBadge,
} from '../publications/tiktok-draft';
import { useAction } from './use-action';

// This project's publications: cancel a scheduled one, retry a failed one (spec 8.4).

export function PublicationsList({
  publications,
  onChanged,
}: {
  publications: Publication[];
  onChanged: () => void;
}) {
  const t = useTranslations('review.publications');
  const f = useFormat();
  const td = useTranslations('publications.tiktokDrafts');
  const badgeFor = usePublicationBadge();
  const { pending, run, busy } = useAction();
  if (publications.length === 0)
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;

  async function act(publication: Publication, action: 'cancel' | 'retry') {
    const ok = await run(
      `${action}-${publication.id}`,
      `/publications/${publication.id}/${action}`,
      {
        success: action === 'cancel' ? t('cancelled') : t('retrying'),
      },
    );
    if (ok) onChanged();
  }

  return (
    <ul className="divide-y divide-border">
      {publications.map((p) => {
        const label = f.platform(p.platform);
        const platformUrl = safeHttpUrl(p.platformUrl);
        return (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {p.state === 'SCHEDULED'
                  ? t('scheduledFor', { date: f.date(p.scheduledFor) })
                  : p.publishedAt && tiktokInboxKind(p)
                    ? td('sentOn', { date: f.date(p.publishedAt) })
                    : p.publishedAt
                      ? t('liveSince', { date: f.date(p.publishedAt) })
                      : t('created', { date: f.date(p.createdAt) })}
                {p.errorReason && (
                  <>
                    {' — '}
                    <FailureReason reason={p.errorReason} />
                  </>
                )}
              </p>
              <TikTokPublicationNote publication={p} />
            </div>
            <StateBadge {...badgeFor(p)} />
            {platformUrl && (
              <Button asChild variant="ghost" size="sm">
                <a href={platformUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> {t('view')}
                </a>
              </Button>
            )}
            {p.state === 'SCHEDULED' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(p, 'cancel')}
                aria-label={t('cancelAria', { platform: label })}
              >
                {pending === `cancel-${p.id}` ? <Loader2 className="animate-spin" /> : <X />}
                {t('cancel')}
              </Button>
            )}
            {p.state === 'FAILED' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(p, 'retry')}
                aria-label={t('retryAria', { platform: label })}
              >
                {pending === `retry-${p.id}` ? <Loader2 className="animate-spin" /> : <RotateCw />}
                {t('retry')}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
