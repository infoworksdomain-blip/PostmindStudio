'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

function Table({
  className,
  containerClassName,
  containerStyle,
  ...props
}: React.ComponentProps<'table'> & {
  containerClassName?: string;
  /** e.g. { maxHeight } so a sticky header sticks inside the scroll area. */
  containerStyle?: React.CSSProperties;
}) {
  return (
    <div
      data-slot="table-container"
      className={cn('relative w-full overflow-x-auto', containerClassName)}
      style={containerStyle}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-surface-raised/60 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-border/70 transition-colors duration-(--duration-fast) hover:bg-surface-raised/60 has-aria-expanded:bg-surface-raised/60 data-[state=selected]:bg-signal-soft/50',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-3 text-start align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pe-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'px-3 py-2.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0',
        className,
      )}
      {...props}
    />
  );
}

/** A body cell that names its row: `<th scope="row">` styled like a cell, not a column head. */
function TableRowHeader({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      scope="row"
      data-slot="table-row-header"
      className={cn(
        'px-3 py-2.5 text-start align-middle font-medium whitespace-nowrap text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableRowHeader,
  TableCaption,
};
