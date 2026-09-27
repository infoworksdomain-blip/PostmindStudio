'use client';

import { LayoutTemplate } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { PLATFORM_LABEL } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { ProjectTemplate } from '../automation/automation';
import { ErrorState } from '../primitives';

// Spec 8.6 / 14.5 — start a video from a template (built-in + this organisation's). "No template"
// keeps the plain brief flow.

function describe(t: ProjectTemplate): string {
  const shots = t.shotBlueprint?.shots?.length;
  const platforms = t.targetFormats.map((f) => PLATFORM_LABEL[f.platform] ?? f.platform);
  return [
    shots ? `${shots} shots` : null,
    platforms.join(', ') || null,
    t.publishDefaults?.publishPolicy === 'AUTO_ON_APPROVAL' ? 'auto-publishes' : null,
    t.builtIn ? null : 'yours',
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
        'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!templates)
    return (
      <div className="grid gap-2 sm:grid-cols-2" aria-label="Loading templates">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">Template</legend>
      <div role="radiogroup" aria-label="Video template" className="grid gap-2 sm:grid-cols-2">
        <Option
          selected={value === null}
          onSelect={() => onChange(null)}
          title="No template"
          detail="Studio plans the video from your brief"
        />
        {templates.map((t) => (
          <Option
            key={t.id}
            selected={value === t.id}
            onSelect={() => onChange(t.id)}
            title={t.name}
            detail={describe(t)}
          />
        ))}
      </div>
    </fieldset>
  );
}
