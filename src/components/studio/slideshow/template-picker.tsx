'use client';

import { Layers } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { ErrorState } from '../primitives';
import { useTemplateCategory } from '../templates/category';
import { slideCount, type SlideshowTemplate } from './types';

// BACKLOG 10.8 — choose a slideshow template (built-in + organisation, A5.7).

export function TemplatePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useTranslations('slideshow.templatePicker');
  const category = useTemplateCategory();
  const { data, error, isLoading, mutate } = useApi<{ data: SlideshowTemplate[] }>(
    '/slideshow-templates',
  );

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return (
      <div className="grid gap-2 sm:grid-cols-2" aria-label={t('loading')}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  if (data.data.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;

  return (
    <div role="radiogroup" aria-label={t('aria')} className="grid gap-2 sm:grid-cols-2">
      {data.data.map((template) => {
        const selected = value === template.id;
        const count = slideCount(template);
        return (
          <button
            key={template.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(template.id)}
            className={cn(
              'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              selected
                ? 'border-foreground bg-foreground/[0.03]'
                : 'border-border hover:border-foreground/40',
            )}
          >
            <Layers className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{template.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {category(template.category, true)}
                {count !== null && ` · ${t('slides', { count })}`}
                {template.organisationId && ` · ${t('yours')}`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
