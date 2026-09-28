'use client';

import { LayoutTemplate } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat, type StudioFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { ProjectTemplate } from '../automation/automation';
import { ErrorState } from '../primitives';

// Spec 8.6 / 14.5 — start a video from a template (built-in + this organisation's). "No template"
// keeps the plain brief flow.

type PickerT = ReturnType<typeof useTranslations<'create.templatePicker'>>;

function describe(template: ProjectTemplate, t: PickerT, f: StudioFormat): string {
  const shots = template.shotBlueprint?.shots?.length;
  const platforms = template.targetFormats.map((format) => f.platform(format.platform));
  return [
    shots ? t('shots', { count: shots }) : null,
    platforms.length ? f.list(platforms) : null,
    template.publishDefaults?.publishPolicy === 'AUTO_ON_APPROVAL' ? t('autoPublishes') : null,
    template.builtIn ? null : t('yours'),
  ]
    .filter(Boolean)
    .join(' · ');
}

function Option({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        selected
          ? 'border-foreground bg-foreground/[0.03]'
          : 'border-border hover:border-foreground/40',
      )}
    >
      <LayoutTemplate className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

export function ProjectTemplatePicker({
  templates,
  error,
  onRetry,
  value,
  onChange,
}: {
  templates: ProjectTemplate[] | undefined;
  error: unknown;
  onRetry: () => void;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations('create.templatePicker');
  const f = useFormat();
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!templates)
    return (
      <div className="grid gap-2 sm:grid-cols-2" aria-label={t('loading')}>
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">{t('legend')}</legend>
      <div role="radiogroup" aria-label={t('aria')} className="grid gap-2 sm:grid-cols-2">
        <Option
          selected={value === null}
          onSelect={() => onChange(null)}
          title={t('none')}
          detail={t('noneDetail')}
        />
        {templates.map((template) => (
          <Option
            key={template.id}
            selected={value === template.id}
            onSelect={() => onChange(template.id)}
            title={template.name}
            detail={describe(template, t, f)}
          />
        ))}
      </div>
    </fieldset>
  );
}
