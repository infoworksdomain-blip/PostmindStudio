'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { nextEnabled, rovingDelta } from './roving';

// BACKLOG 25.3 — a compact single choice between 2–5 options (date range, view, metric).
// Radio semantics with roving focus: Tab reaches the checked option, arrow keys move and select,
// Home / End jump; left and right follow the reading direction. The checked segment is a raised
// surface on a quiet track — no accent colour, the choice is not a call to action.

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  /** Accessible name of the group (or pass `aria-labelledby`). */
  label?: string;
  'aria-labelledby'?: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'default';
  /** Stretch the segments to fill the row. */
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string | number>({
  label,
  'aria-labelledby': labelledBy,
  options,
  value,
  onChange,
  size = 'default',
  fullWidth = false,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = options.findIndex((o) => o.value === value);
  const off = options.map((o) => disabled || !!o.disabled);
  const firstEnabled = off.indexOf(false);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = Math.max(index, 0);
    const delta = rovingDelta(event, options.length, from);
    if (delta === null) return;
    event.preventDefault();
    const next = nextEnabled(from, delta, off);
    const option = next === null ? undefined : options[next];
    if (next === null || !option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      data-slot="segmented-control"
      onKeyDown={onKey}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-field bg-surface-raised p-0.5',
        fullWidth && 'flex w-full',
        className,
      )}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={off[i]}
            tabIndex={checked || (index === -1 && i === firstEnabled) ? 0 : -1}
            onClick={() => onChange(o.value)}
            data-state={checked ? 'checked' : 'unchecked'}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap',
              'transition-[color,background-color,box-shadow] duration-(--duration-fast) ease-standard',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-45',
              "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              fullWidth && 'flex-1',
              checked
                ? 'bg-background text-foreground shadow-raised dark:bg-surface-active'
                : 'text-foreground-secondary hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
