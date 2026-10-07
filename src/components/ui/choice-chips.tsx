'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nextEnabled, rovingDelta } from './roving';

// BACKLOG 25.3 — choice chips for picking one or several of a short, wrapping set (platforms,
// tones, formats, sources).
//   type="single"   → role=radiogroup; arrow keys move and select (roving tab stop).
//   type="multiple" → role=group of role=checkbox buttons; arrow keys move focus, Space/Enter
//                     toggles. Selected chips carry a check so the state never rests on colour.
// A selected chip is ink on a raised wash with a strong edge — the accent stays for actions.

export interface ChoiceOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Extra accessible text (e.g. a price or "not in your plan"). */
  description?: string;
}

interface CommonProps<T extends string | number> {
  /** Accessible name (or pass `aria-labelledby`, e.g. the legend's id). */
  label?: string;
  'aria-labelledby'?: string;
  options: ReadonlyArray<ChoiceOption<T>>;
  disabled?: boolean;
  size?: 'sm' | 'default';
  className?: string;
}

export type ChoiceChipsProps<T extends string | number> = CommonProps<T> &
  (
    | { type: 'single'; value: T | null | undefined; onChange: (value: T) => void }
    | { type: 'multiple'; value: readonly T[]; onChange: (value: T[]) => void }
  );

export function ChoiceChips<T extends string | number>(props: ChoiceChipsProps<T>) {
  const {
    label,
    'aria-labelledby': labelledBy,
    options,
    disabled = false,
    size = 'default',
    className,
  } = props;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const off = options.map((o) => disabled || !!o.disabled);
  const isChecked = (v: T) =>
    props.type === 'single' ? props.value === v : props.value.includes(v);
  const checkedIndex = options.findIndex((o) => isChecked(o.value));
  const firstEnabled = off.indexOf(false);
  const tabStop =
    props.type === 'single' && checkedIndex !== -1 && !off[checkedIndex]
      ? checkedIndex
      : firstEnabled;

  const select = (v: T) => {
    if (props.type === 'single') props.onChange(v);
    else
      props.onChange(
        props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v],
      );
  };

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
    if (props.type === 'single') props.onChange(option.value);
  };

  return (
    <div
      role={props.type === 'single' ? 'radiogroup' : 'group'}
      aria-label={label}
      aria-labelledby={labelledBy}
      data-slot="choice-chips"
      onKeyDown={onKey}
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {options.map((o, i) => {
        const checked = isChecked(o.value);
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={props.type === 'single' ? 'radio' : 'checkbox'}
            aria-checked={checked}
            aria-description={o.description}
            disabled={off[i]}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => select(o.value)}
            data-state={checked ? 'checked' : 'unchecked'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap select-none',
              'transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) ease-standard',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-45',
              "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              checked
                ? 'border-foreground/70 bg-surface-active text-foreground'
                : 'border-border-strong text-foreground-secondary hover:border-input hover:bg-surface-raised hover:text-foreground',
            )}
          >
            {checked && props.type === 'multiple' && (
              <Check aria-hidden data-slot="chip-check" className="-ms-0.5" strokeWidth={2.5} />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
