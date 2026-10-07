'use client';

import { useTranslations } from 'next-intl';
import { Clock, Sparkles } from 'lucide-react';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { PlanPreviewModel } from './plan-model';

// BACKLOG 25.9 — "What Studio will make" beside the month planner: how many posts, the video /
// slideshow split, the dates and networks, a strip with one column per day (a dot per post), and
// how the month is made — topics first for review, then each post about three days before it goes
// out (23.6 rolling generation, STUDIO_PLAN_LEAD_HOURS default 72). The strip is decorative; the
// sentences carry the same facts for screen readers.

export function PlanPreview({
  preview,
  platforms,
}: {
  preview: PlanPreviewModel;
  platforms: readonly string[];
}) {
  const t = useTranslations('plans.new.preview');
  const f = useFormat();
  const day = (key: string) =>
    f.date(`${key}T12:00:00Z`, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <section
      aria-labelledby="plan-preview-title"
      className="flex flex-col gap-4 rounded-panel border border-border bg-card p-5"
      data-testid="plan-preview"
    >
      <h2 id="plan-preview-title" className="text-xs font-medium text-muted-foreground">
        {t('title')}
      </h2>
      <p className="flex flex-col gap-1" aria-live="polite">
        <span className="text-xs text-muted-foreground">{t('upTo')}</span>
        <span className="tabular text-4xl leading-none font-semibold tracking-tight">
          {f.number(preview.count)}
        </span>
        <span className="text-sm text-foreground-secondary">
          {t('split', {
            videos: preview.videos,
            slideshows: preview.slideshows,
          })}
        </span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t('dates')}</dt>
        <dd>{t('range', { start: day(preview.startDate), end: day(preview.endDate) })}</dd>
        <dt className="text-muted-foreground">{t('networks')}</dt>
        <dd>{platforms.length ? f.list(platforms.map((p) => f.platform(p))) : t('noNetworks')}</dd>
      </dl>
      {preview.perDay.length > 0 && (
        <div
          aria-hidden
          className="grid gap-0.5"
          style={{
            gridTemplateColumns: `repeat(${Math.min(preview.perDay.length, 31)}, minmax(0, 1fr))`,
          }}
        >
          {preview.perDay.map((n, i) => (
            <span
              key={i}
              className={cn(
                'flex h-10 flex-col-reverse items-center gap-0.5 rounded-[3px] bg-surface-raised py-1',
                i % 7 === 0 && i > 0 && 'ms-0.5',
              )}
            >
              {Array.from({ length: n }, (_, j) => (
                <span key={j} className="size-1 rounded-full bg-foreground/70" />
              ))}
            </span>
          ))}
        </div>
      )}
      <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
        <li className="flex gap-2">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('review')}
        </li>
        <li className="flex gap-2">
          <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('rolling')}
        </li>
      </ul>
    </section>
  );
}
