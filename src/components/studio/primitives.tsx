'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Inbox, RotateCw, SearchX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ApiError, useErrorMessage } from '@/lib/client/api';
import type { Tone } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { EmptyIllustration, type IllustrationName } from './empty-illustration';

// Shared building blocks for Studio screens: page header, state badge (with a pulsing
// "record" light for work in progress), empty and error states, section card.

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-border/70 pb-6">
      <div className="max-w-2xl">
        {eyebrow && (
          <p className="mb-2 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-4xl leading-none md:text-5xl">{title}</h1>
        {description && <p className="mt-3 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  live: 'bg-primary/10 text-primary',
  good: 'bg-success/12 text-success',
  warn: 'bg-warning/18 text-foreground',
  bad: 'bg-destructive/12 text-destructive',
};

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
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {tone === 'live' && (
        <span aria-hidden className="size-1.5 animate-rec rounded-full bg-primary" />
      )}
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  illustration,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  /** Phase 20.8: an original line drawing (decorative) in place of the icon. */
  illustration?: IllustrationName;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-4 text-muted-foreground">
        {illustration ? (
          <EmptyIllustration name={illustration} />
        ) : (
          (icon ?? <Inbox className="size-8" strokeWidth={1.5} />)
        )}
      </div>
      <h2 className="font-display text-2xl">{title}</h2>
      {description && <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
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
    <div
      role="status"
      className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6 text-sm"
    >
      <SearchX className="size-6 text-muted-foreground" aria-hidden />
      <div>
        <p className="text-base font-medium">{copy.title}</p>
        <p className="mt-1 text-muted-foreground">{copy.body}</p>
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
 * A failed request. With `notFound`, a 404 becomes a proper "not found" page with a way back
 * instead of "Couldn't load this" and a Retry that can never succeed.
 */
export function ErrorState({
  error,
  onRetry,
  notFound,
}: {
  error: unknown;
  onRetry?: () => void;
  notFound?: NotFoundCopy;
}) {
  const t = useTranslations('primitives');
  const errorMessage = useErrorMessage();
  if (notFound && error instanceof ApiError && error.status === 404)
    return <NotFoundState copy={notFound} />;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex-1">
        <p className="font-medium text-destructive">{t('errorTitle')}</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw /> {t('retry')}
        </Button>
      )}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-card p-5 shadow-[0_1px_0_rgb(0_0_0/0.03)]',
        className,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
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
      <p className="tabular mt-1 font-display text-3xl leading-none">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
