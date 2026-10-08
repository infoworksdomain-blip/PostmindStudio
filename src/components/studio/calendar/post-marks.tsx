'use client';

import { useTranslations } from 'next-intl';
import { CalendarRange, Repeat } from 'lucide-react';
import { useFormat } from '@/lib/client/format';
import type { PublicationCampaign } from '@/lib/client/types';
import { cn } from '@/lib/utils';

// BACKLOG 25.9 — the small marks on a calendar post: which network (a short text mark; the
// card's own label says the full name, so the mark is hidden from screen readers) and which
// month plan or automation it came from.

/** Short, language-neutral network marks (brand abbreviations). */
export const PLATFORM_MARK: Readonly<Record<string, string>> = {
  tiktok: 'TT',
  instagram_reel: 'IG',
  instagram_feed: 'IG',
  youtube_short: 'YT',
  youtube: 'YT',
  linkedin_video: 'in',
  x: 'X',
  facebook: 'FB',
  facebook_feed: 'FB',
};

export function platformMark(platform: string): string {
  return PLATFORM_MARK[platform] ?? platform.slice(0, 2).toUpperCase();
}

export function PlatformMark({
  platform,
  compact = false,
}: {
  platform: string;
  compact?: boolean;
}) {
  return (
    <span
      aria-hidden
      data-platform-mark={platform}
      className={cn(
        'shrink-0 rounded-[3px] border border-border-strong font-mono leading-none font-medium text-foreground-secondary',
        compact ? 'px-0.5 py-px text-[0.55rem]' : 'px-1 py-0.5 text-[0.625rem]',
      )}
    >
      {platformMark(platform)}
    </span>
  );
}

/** "Month plan · 1 Oct" or the automation's name; nothing for a post made by hand. */
export function CampaignLabel({
  campaign,
  className,
}: {
  campaign: PublicationCampaign | null | undefined;
  className?: string;
}) {
  const t = useTranslations('calendar.campaign');
  const f = useFormat();
  if (!campaign) return null;
  const Icon = campaign.kind === 'automation' ? Repeat : CalendarRange;
  const text =
    campaign.kind === 'automation'
      ? t('automation', { name: campaign.name })
      : t('plan', {
          date: f.date(`${campaign.startDate}T12:00:00Z`, {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          }),
        });
  return (
    <span
      data-campaign={campaign.kind}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}
