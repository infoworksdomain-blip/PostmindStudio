import * as React from 'react';
import { cn } from '@/lib/utils';

// BACKLOG 25.3 — the one status pill. A soft tinted wash with the tone's text-safe foreground
// (WCAG AA at 12px, test/unit/design-tokens-contrast.test.ts) and an optional leading dot.
//   neutral — waiting, draft, archived.        live — generating / publishing (signal; the dot pulses).
//   good — done, connected, active.            warn — needs attention soon.
//   bad — failed, blocked, removed.            info — informational marks (data teal dot).

export type StatusTone = 'neutral' | 'live' | 'good' | 'warn' | 'bad' | 'info';

const WASH: Record<StatusTone, string> = {
  neutral: 'bg-surface-raised text-foreground-secondary',
  live: 'bg-signal-soft text-primary',
  good: 'bg-success-soft text-success-foreground',
  warn: 'bg-warning-soft text-warning-foreground',
  bad: 'bg-destructive-soft text-destructive-foreground',
  info: 'bg-data-soft text-foreground',
};

const DOT: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  live: 'bg-primary animate-rec',
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  info: 'bg-data',
};

type StatusPillProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  tone?: StatusTone;
  children: React.ReactNode;
  /** A leading dot; on by default for `live` (it pulses), off otherwise. */
  dot?: boolean;
  /** A small leading icon instead of the dot (decorative; the label carries the meaning). */
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
};

function StatusPill({
  tone = 'neutral',
  dot,
  icon,
  size = 'md',
  className,
  children,
  ...props
}: StatusPillProps) {
  const showDot = !icon && (dot ?? tone === 'live');
  return (
    <span
      data-slot="status-pill"
      data-tone={tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0',
        size === 'sm' ? 'h-5 px-2 text-[0.6875rem]' : 'h-6 px-2.5 text-xs',
        WASH[tone],
        className,
      )}
      {...props}
    >
      {showDot && (
        <span
          aria-hidden
          data-slot="status-dot"
          className={cn('size-1.5 rounded-full', DOT[tone])}
        />
      )}
      {icon}
      {children}
    </span>
  );
}

export { StatusPill, type StatusPillProps };
