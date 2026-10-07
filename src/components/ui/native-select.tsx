import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fieldBase } from './field-styles';

// BACKLOG 25.3 — the styled native <select>: for long simple lists, filters and phones (the OS
// picker is the best picker there). Same value / onChange semantics as a raw <select>; pass an
// `id` and pair it with a <Label htmlFor> (or an aria-label) so it keeps its name. For a short
// list with rich items use `Select` (Radix) instead.

type NativeSelectProps = React.ComponentProps<'select'> & {
  /** `sm` for dense toolbars and table filters. */
  size?: 'sm' | 'default';
  /** Classes for the wrapper (width, margins); `className` styles the select itself. */
  wrapperClassName?: string;
};

function NativeSelect({
  className,
  wrapperClassName,
  size = 'default',
  children,
  ...props
}: NativeSelectProps) {
  return (
    <div
      data-slot="native-select-wrapper"
      className={cn('relative inline-flex w-full min-w-0', wrapperClassName)}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          fieldBase,
          'cursor-pointer appearance-none ps-3 pe-9',
          size === 'sm' ? 'h-8 text-sm' : 'h-9',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export { NativeSelect, type NativeSelectProps };
