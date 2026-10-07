'use client';

import { useTranslations } from 'next-intl';
import { Lightbulb } from 'lucide-react';
import { isVagueBrief } from '@/lib/client/brief-hint';
import { cn } from '@/lib/utils';

// BACKLOG 20.18 — a gentle hint under a brief field when what is typed is very short or generic.
// It never blocks submission (the field's form submits as before); it only suggests adding who
// the video is for, what to say or the feel wanted. Pass `id` and point the field's
// aria-describedby at it (briefHintDescribedBy) so screen readers read it with the field.

export function briefHintDescribedBy(text: string, id: string): string | undefined {
  return isVagueBrief(text) ? id : undefined;
}

export function BriefHint({
  text,
  id,
  className,
}: {
  /** The brief as typed. */
  text: string;
  id: string;
  className?: string;
}) {
  const t = useTranslations('common');
  if (!isVagueBrief(text)) return null;
  return (
    <p
      id={id}
      role="status"
      data-testid="brief-hint"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-foreground/80',
        className,
      )}
    >
      <Lightbulb className="mt-px size-3.5 shrink-0 text-warning-foreground" aria-hidden />
      <span>{t('briefHint')}</span>
    </p>
  );
}
