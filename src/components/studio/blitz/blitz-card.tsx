'use client';

import { useTranslations } from 'next-intl';
import { Lightbulb, Repeat2, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { CardMedia } from './card-media';
import type { BlitzCard } from './blitz-model';

// 22.4 — one Blitz card: the media (rendered carousel / slideshow, or the preview of a paid
// format) and, under it, the angle and format chips, the working title, "Why this works" and,
// on narrow screens, a tap to see the trend it remixes (beside the card on wide screens).

export function FormatChip({ card }: { card: Pick<BlitzCard, 'format' | 'tier'> }) {
  const t = useTranslations('blitz.deck');
  return (
    <StatusPill tone={card.tier === 'premade' ? 'info' : 'warn'} size="sm">
      {t(`format.${card.format}`)}
    </StatusPill>
  );
}

export function BlitzCardView({
  card,
  active,
  onShowRemix,
}: {
  card: BlitzCard;
  active: boolean;
  onShowRemix?: () => void;
}) {
  const t = useTranslations('blitz.deck');
  const portrait = card.format !== 'carousel' || card.tier === 'preview';
  return (
    <div className="flex size-full flex-col bg-card">
      <div
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-muted',
          !portrait && 'flex items-center justify-center',
        )}
      >
        <div className={cn('size-full', !portrait && 'aspect-[4/5] h-auto max-h-full')}>
          <CardMedia card={card} active={active} />
        </div>
        <span className="absolute start-3 top-3 rounded-full bg-background/85 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm backdrop-blur">
          {card.tier === 'premade' ? t('tier.premade') : t('tier.preview')}
        </span>
      </div>
      <div className="space-y-2 border-t border-border/70 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <FormatChip card={card} />
          {card.angle && (
            <span className="inline-flex max-w-full items-center truncate rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-foreground-secondary">
              {card.angle.title}
            </span>
          )}
          {card.mentionBusiness && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
              title={t('mentionsBusiness')}
            >
              <Store className="size-3" aria-hidden />
              <span className="sr-only">{t('mentionsBusiness')}</span>
            </span>
          )}
        </div>
        <p className="line-clamp-2 font-display text-xl leading-tight">{card.title}</p>
        <p className="flex gap-1.5 text-xs leading-snug text-muted-foreground">
          <Lightbulb className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            <span className="font-semibold text-foreground">{t('why')}: </span>
            {card.whyItWorks}
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {card.allowanceUnits < 1
              ? t('allowanceQuick')
              : t('allowance', { units: card.allowanceUnits })}
          </span>
          {card.remix && onShowRemix && (
            <Button
              variant="link"
              size="xs"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onShowRemix}
              className="text-[11px] lg:hidden"
            >
              <Repeat2 aria-hidden />
              {t('remix.show')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function RemixSource({ card }: { card: BlitzCard }) {
  const t = useTranslations('blitz.deck');
  if (!card.remix) return null;
  return (
    <figure className="w-full max-w-[14rem] space-y-2">
      <figcaption className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        <Repeat2 className="size-3.5" aria-hidden />
        {t('remix.title')}
      </figcaption>
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-border/70 bg-muted shadow-sm">
        {card.remix.thumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- signed thumbnail
          <img
            src={card.remix.thumbnailUrl}
            alt={card.remix.title}
            className="size-full object-cover"
          />
        )}
        <span className="absolute end-2 bottom-2 rounded bg-scrim px-1.5 py-0.5 text-[10px] text-white">
          {t('remix.seconds', { seconds: Math.round(card.remix.durationSec) })}
        </span>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{card.remix.title}</p>
      <p className="text-[11px] text-muted-foreground">{t('remix.note')}</p>
    </figure>
  );
}
