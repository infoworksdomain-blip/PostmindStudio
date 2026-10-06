'use client';

import { useTranslations } from 'next-intl';
import { Archive, Pencil, RefreshCw, Star, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StateBadge } from '../primitives';
import type { Creator } from '../creators/types';

// BACKLOG 22.3 — one creator in the Creators grid: the portrait (the face every video that picks
// this creator uses), name, look, status and the actions. Never a cost.

const STATUS_TONE = { READY: 'good', DRAFT: 'warn', RETIRED: 'neutral' } as const;

export interface CreatorActions {
  onRegenerate: () => void;
  onRename: () => void;
  onMakeDefault: () => void;
  onRetire: () => void;
}

export function CreatorCard({
  creator,
  busy,
  actions,
}: {
  creator: Creator;
  busy: boolean;
  actions: CreatorActions;
}) {
  const t = useTranslations('business.creators');
  const tu = useTranslations('create.ugc');
  const retired = creator.status === 'RETIRED';
  const look = [
    tu(`genders.${creator.gender}`),
    tu(`ages.${creator.ageRange}`),
    tu(`settings.${creator.setting}`),
  ].join(' · ');
  return (
    <li
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring"
      data-testid={`creator-${creator.id}`}
    >
      <div className="relative aspect-[3/4] bg-muted">
        {creator.portraitUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not optimisable
          <img
            src={creator.portraitUrl}
            alt={t('portraitAlt', { name: creator.name })}
            className={`size-full object-cover transition-transform duration-300 group-hover:scale-[1.02] ${retired ? 'grayscale' : ''}`}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <UserRound className="size-10" strokeWidth={1.25} aria-hidden />
            {creator.portraitError ? t('portraitError') : t('status.DRAFT')}
          </div>
        )}
        <div className="absolute top-2 start-2 flex flex-wrap gap-1.5">
          <StateBadge label={t(`status.${creator.status}`)} tone={STATUS_TONE[creator.status]} />
          {creator.isDefault && <StateBadge label={t('default')} tone="good" />}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="min-w-0">
          <h3 className="truncate font-display text-2xl leading-tight">{creator.name}</h3>
          <p className="truncate text-xs text-muted-foreground">{look}</p>
          {creator.appearance && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{creator.appearance}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {[
              t('uses', { count: creator.useCount }),
              creator.portraitSource === 'UPLOAD' && t('uploaded'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {!retired && (
          <div className="mt-auto flex flex-wrap gap-1">
            {creator.portraitSource !== 'UPLOAD' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={actions.onRegenerate}
                aria-label={t('regenerateAria', { name: creator.name })}
              >
                <RefreshCw /> {t('regenerate')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={actions.onRename}
              aria-label={t('renameAria', { name: creator.name })}
            >
              <Pencil /> {t('rename')}
            </Button>
            {creator.status === 'READY' && !creator.isDefault && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={actions.onMakeDefault}
                aria-label={t('makeDefaultAria', { name: creator.name })}
              >
                <Star /> {t('makeDefault')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={actions.onRetire}
              aria-label={t('retireAria', { name: creator.name })}
            >
              <Archive /> {t('retire')}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
