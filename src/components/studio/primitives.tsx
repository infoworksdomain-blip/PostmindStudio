'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Inbox, RotateCw, SearchX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { ApiError, useErrorMessage } from '@/lib/client/api';
import type { Tone } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { EmptyIllustration, type IllustrationName } from './empty-illustration';

// Shared building blocks for Studio screens: page header, state badge (with a pulsing
// "record" light for work in progress), empty and error states, sections and stats.
// BACKLOG 25.3: hierarchy comes from the type scale and spacing, not from boxes — a Section is
// an open block with a hairline above it unless it is genuinely an object (`variant="panel"`).

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn('mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4', className)}
    >
      <div className="max-w-2xl min-w-0">
        {eyebrow && (
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">{eyebrow}</p>
        )}
        <h1 className="font-display text-[1.75rem] leading-[1.15] md:text-[2.25rem] md:leading-[1.1]">
          {title}
        </h1>
        {description && (
          <div className="mt-2 text-[0.9375rem] leading-relaxed text-foreground-secondary">
            {description}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A state label (project, publication, job) — the StatusPill with the app's tone names. */
export function StateBadge({
  label,
  tone,
  className,
}: {
  label: string;
  tone: Tone;
  className?: string;
}) {
  return (
    <StatusPill tone={tone} className={className}>
      {label}
    </StatusPill>
  );
}

/**
 * Nothing here yet. The title says what is missing, the description why and what to do next,
 * `action` is the one way forward. `media` is an illustration name (a line drawing) or any node
 * (an icon); it is decorative.
 */
export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  media,
  size = 'default',
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  media?: IllustrationName | ReactNode;
  size?: 'default' | 'compact';
  className?: string;
}) {
  const art =
    typeof media === 'string' ? (
      <EmptyIllustration name={media as IllustrationName} />
    ) : media ? (
      media
    ) : (
      <Inbox className="size-8" strokeWidth={1.5} />
    );
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'compact' ? 'px-4 py-8' : 'px-6 py-16',
        className,
      )}
    >
      <div aria-hidden className="mb-5 text-muted-foreground">
        {art}
      </div>
      <h2
        className={cn(
          'font-display text-balance',
          size === 'compact' ? 'text-lg' : 'text-xl md:text-2xl',
        )}
      >
        {title}
      </h2>
      {description && (
        <div className="mt-2 max-w-md text-sm leading-relaxed text-pretty text-foreground-secondary">
          {description}
        </div>
      )}
      {(action || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/** What a detail page says when the thing it was opened for does not exist (HTTP 404). */
export interface NotFoundCopy {
  title: string;
  body: string;
  /** Where "back" goes, and what the link says. */
  href: string;
  action: string;
}

export function NotFoundState({ copy }: { copy: NotFoundCopy }) {
  return (
    <div role="status" className="flex flex-col items-start gap-3 py-8 text-sm">
      <SearchX className="size-6 text-muted-foreground" aria-hidden />
      <div>
        <p className="text-lg font-semibold tracking-tight">{copy.title}</p>
        <p className="mt-1 text-foreground-secondary">{copy.body}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href={copy.href}>
          <ArrowLeft className="rtl:-scale-x-100" /> {copy.action}
        </Link>
      </Button>
    </div>
  );
}

/**
 * A failed request, in plain words, with a way to try again. With `notFound`, a 404 becomes a
 * proper "not found" page with a way back instead of a Retry that can never succeed.
 */
export function ErrorState({
  error,
  onRetry,
  notFound,
  title,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  notFound?: NotFoundCopy;
  /** Overrides "Couldn't load this" when the context says more (e.g. "Couldn't load your plan"). */
  title?: string;
  className?: string;
}) {
  const t = useTranslations('primitives');
  const errorMessage = useErrorMessage();
  if (notFound && error instanceof ApiError && error.status === 404)
    return <NotFoundState copy={notFound} />;
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-field bg-destructive-soft px-4 py-3.5 text-sm',
        className,
      )}
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive-foreground">{title ?? t('errorTitle')}</p>
        <p className="mt-0.5 text-foreground-secondary">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="bg-background">
          <RotateCw /> {t('retry')}
        </Button>
      )}
    </div>
  );
}

/**
 * A titled block of a page. Open by default: heading, optional description and actions, then
 * the content, divided from the block above by a hairline and space. `variant="panel"` is for
 * things that read as an object you pick up or open (a media preview, a form that must read as
 * one unit): a raised surface with the panel radius.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  variant = 'open',
  id,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: 'open' | 'panel';
  id?: string;
}) {
  return (
    <section
      id={id}
      data-slot="section"
      data-variant={variant}
      className={cn(
        variant === 'panel'
          ? 'rounded-panel border border-border bg-card p-5 shadow-raised md:p-6'
          : 'border-t border-border pt-6',
        className,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && (
            <div className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground-secondary">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Big tabular number with a small caption — dashboards and summaries. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-3xl leading-none tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
