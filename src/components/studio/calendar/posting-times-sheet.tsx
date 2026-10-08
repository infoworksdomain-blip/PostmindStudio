'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { directionOf, isLocale } from '@/lib/i18n/locales';
import { DripQueuePanel } from './drip-queue';

// BACKLOG 25.9 — the posting times (drip queue, 15.A5 / 20.14) moved off the bottom of the
// calendar into a side sheet opened from the header's "Posting times" button, so the calendar
// stays content first. The sheet sits at the inline end: right in English, left in Arabic.

export function PostingTimesSheet({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('calendar.postingTimes');
  const locale = useLocale();
  const rtl = isLocale(locale) && directionOf(locale) === 'rtl';
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={rtl ? 'left' : 'right'}
        data-testid="posting-times-sheet"
        className="w-full gap-0 overflow-y-auto sm:max-w-xl data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <div className="p-5">
          <DripQueuePanel bare onSaved={onSaved} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
