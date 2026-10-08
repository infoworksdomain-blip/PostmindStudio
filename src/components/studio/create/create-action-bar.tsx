'use client';

import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import {
  CREATE_BLOCK_NOTICE_ID,
  CreateBlockedNotice,
  type useCreateBlock,
} from '../account/create-access';
import type { CreateSource } from './body';
import type { AllowanceLine } from './create-allowance';

// BACKLOG 25.7 — Create's primary action: what will be made (the options summary), what it uses
// of the plan's allowance, and the one Generate button. Below xl it is the last thing in the form
// and sticks to the bottom of the screen (thumb reach on phones); on xl it ends the sticky
// options column.

export interface CreateActionBarProps {
  source: CreateSource;
  /** Separate facts (platforms, length, posting, brand kit), shown joined by a middle dot. */
  summary: string[];
  allowance: AllowanceLine;
  submitting: boolean;
  disabled: boolean;
  block: ReturnType<typeof useCreateBlock>;
}

export function CreateActionBar(props: CreateActionBarProps) {
  const { source, allowance } = props;
  const t = useTranslations('create.screen');
  const f = useFormat();
  const uses =
    allowance.usesVideos === 0.25
      ? t('usesQuick')
      : t('usesVideos', { count: allowance.usesVideos });
  return (
    <div
      data-slot="create-action-bar"
      className={cn(
        'grid gap-3',
        'max-xl:sticky max-xl:bottom-0 max-xl:z-(--z-sticky) max-xl:-mx-4 max-xl:border-t max-xl:border-border max-xl:bg-background/95 max-xl:px-4 max-xl:pt-3 max-xl:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-xl:backdrop-blur',
        'xl:sticky xl:bottom-0 xl:z-(--z-sticky) xl:rounded-2xl xl:border xl:border-border xl:bg-card xl:p-4 xl:shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.15)]',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-0.5 text-xs">
          <p className="text-foreground-secondary">{props.summary.join(' · ')}</p>
          <p className="text-muted-foreground tabular-nums" data-testid="create-allowance">
            {uses}
            {allowance.leftVideos !== null && allowance.limitVideos !== null && (
              <>
                {' · '}
                {t('allowanceLeft', {
                  left: f.number(allowance.leftVideos),
                  limit: f.number(allowance.limitVideos),
                  period: allowance.period,
                })}
              </>
            )}
          </p>
        </div>
        <Button
          type="submit"
          size="lg"
          loading={props.submitting}
          disabled={props.disabled}
          aria-describedby={props.block ? CREATE_BLOCK_NOTICE_ID : undefined}
          className="px-4 max-sm:flex-1"
        >
          {!props.submitting && <ArrowRight className="rtl:-scale-x-100" />}
          {source === 'SLIDESHOW'
            ? t('createSlideshow')
            : source === 'CAROUSEL'
              ? t('createCarousel')
              : t('generate')}
        </Button>
      </div>
      <CreateBlockedNotice block={props.block} className="text-sm text-destructive" />
    </div>
  );
}
