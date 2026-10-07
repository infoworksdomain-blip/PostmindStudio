'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { nextEnabled, rovingDelta } from '@/components/ui/roving';
import { cn } from '@/lib/utils';

// BACKLOG 25.3 — a single choice between a few rich options (a title, a hint line, an icon):
// the automation wizard's cadence and approval steps and the Blitz "keep" dialog. ChoiceChips
// and SegmentedControl are one-line pills; these keep the hint visible so the options can be
// compared. Radio semantics with the shared roving focus: Tab reaches the checked card, arrow
// keys move and select, Home / End jump. The selection matches ChoiceChips: ink edge on a wash.

export interface OptionCard<T extends string> {
  value: T;
  title: ReactNode;
  hint?: ReactNode;
  /** A decorative leading icon. */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface OptionCardsProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: ReadonlyArray<OptionCard<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Focus the checked card on mount (e.g. the first stop in a dialog). */
  autoFocusChecked?: boolean;
  className?: string;
}

export function OptionCards<T extends string>({
  label,
  options,
  value,
  onChange,
  autoFocusChecked = false,
  className,
}: OptionCardsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const off = options.map((o) => !!o.disabled);
  const index = options.findIndex((o) => o.value === value);
  const tabStop = index !== -1 && !off[index] ? index : off.indexOf(false);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === event.target);
    if (from === -1) return;
    const delta = rovingDelta(event, options.length, from);
    if (delta === null) return;
    event.preventDefault();
    const next = nextEnabled(from, delta, off);
    const option = next === null ? undefined : options[next];
    if (next === null || !option) return;
    refs.current[next]?.focus();
    onChange(option.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="option-cards"
      onKeyDown={onKey}
      className={cn('grid gap-3', className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={off[i]}
            tabIndex={i === tabStop ? 0 : -1}
            autoFocus={autoFocusChecked && checked}
            onClick={() => onChange(o.value)}
            data-state={checked ? 'checked' : 'unchecked'}
            className={cn(
              'flex items-start gap-3 rounded-field border p-4 text-start',
              'transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) ease-standard',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-45',
              "[&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              checked
                ? 'border-foreground/70 bg-surface-active [&_svg]:text-foreground'
                : 'border-border-strong hover:bg-surface-raised [&_svg]:text-muted-foreground',
            )}
          >
            {o.icon}
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.title}</span>
              {o.hint && (
                <span className="mt-0.5 block text-xs text-foreground-secondary">{o.hint}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
