'use client';

import { Layers } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { ErrorState } from '../primitives';
import { categoryLabel, slideCount, type SlideshowTemplate } from './types';

// BACKLOG 10.8 — choose a slideshow template (built-in + organisation, A5.7).

export function TemplatePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string) => void;
}) {
  const { data, error, isLoading, mutate } = useApi<{ data: SlideshowTemplate[] }>(
    '/slideshow-templates',
  );

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return (
      <div className="grid gap-2 sm:grid-cols-2" aria-label="Loading templates">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  if (data.data.length === 0)
    return <p className="text-sm text-muted-foreground">No slideshow templates are available.</p>;

  return (
    <div role="radiogroup" aria-label="Slideshow template" className="grid gap-2 sm:grid-cols-2">
      {data.data.map((t) => {
        const selected = value === t.id;
        const count = slideCount(t);
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(t.id)}
            className={cn(
              'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              selected
                ? 'border-foreground bg-foreground/[0.03]'
                : 'border-border hover:border-foreground/40',
            )}
          >
            <Layers className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{t.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {categoryLabel(t.category)}
                {count !== null && ` · ${count} slides`}
                {t.organisationId && ' · yours'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
