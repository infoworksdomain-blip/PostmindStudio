'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

// BACKLOG 25.3 — the one data table, built on ui/table. Minimal borders (hairline rows, no
// column rules), a sticky header (inside `maxHeight`), sortable headers with aria-sort, optional
// row selection with a bulk-action bar, loading and empty rows, and two responsive modes:
// `scroll` (a horizontal scroll container, the default) or `stack` (each row becomes a small
// labelled card under the `sm` breakpoint).

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  id: string;
  direction: SortDirection;
}
type SortValue = string | number | Date | boolean | null | undefined;

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Makes the column sortable by this value. */
  sortValue?: (row: Row) => SortValue;
  align?: 'start' | 'end' | 'center';
  className?: string;
  headerClassName?: string;
  /** The label shown beside the value in stacked (phone) rows; defaults to `header`. */
  mobileLabel?: ReactNode;
  /** Leave the column out of stacked rows (e.g. an action column shown elsewhere). */
  hideWhenStacked?: boolean;
  /**
   * The cell names its row (a tier, a queue, a provider): it renders as `<th scope="row">`, so
   * screen readers announce it with every other cell in the row.
   */
  rowHeader?: boolean;
}

export interface DataTableProps<Row> {
  columns: ReadonlyArray<DataTableColumn<Row>>;
  rows: readonly Row[] | undefined;
  getRowId: (row: Row) => string;
  /** Accessible name of the table (visually hidden unless `showCaption`). */
  caption?: string;
  showCaption?: boolean;
  loading?: boolean;
  loadingRows?: number;
  /** Shown in a single full-width row when there are no rows. */
  empty?: ReactNode;
  /** Initial sort (uncontrolled) or the current sort (with `onSortChange`). */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** Turns on row selection; the ids are controlled by the caller. */
  selectedIds?: ReadonlySet<string>;
  onSelectedIdsChange?: (ids: Set<string>) => void;
  /** What a row's checkbox is called, e.g. its name ("Select Acme Ltd"). */
  rowLabel?: (row: Row) => string;
  /** Actions for the selected rows, shown in the bulk bar above the table. */
  bulkActions?: (ids: string[]) => ReactNode;
  responsive?: 'scroll' | 'stack';
  /** A max height (CSS length) for the scroll area; the header sticks inside it. */
  maxHeight?: string;
  dense?: boolean;
  rowClassName?: (row: Row) => string | undefined;
  className?: string;
}

function compare(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Rows ordered by a column's sort value (stable; empty values last in both directions). */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: ReadonlyArray<DataTableColumn<Row>>,
  sort: SortState | null | undefined,
): Row[] {
  const column = sort ? columns.find((c) => c.id === sort.id) : undefined;
  const value = column?.sortValue;
  if (!sort || !value) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const a = value(x.row);
      const b = value(y.row);
      const empty = (v: SortValue) => v === null || v === undefined;
      if (empty(a) !== empty(b)) return empty(a) ? 1 : -1;
      return compare(a, b) * sign || x.index - y.index;
    })
    .map((x) => x.row);
}

const ALIGN = { start: 'text-start', end: 'text-end', center: 'text-center' } as const;

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  caption,
  showCaption = false,
  loading = false,
  loadingRows = 3,
  empty,
  sort: sortProp,
  onSortChange,
  selectedIds,
  onSelectedIdsChange,
  rowLabel,
  bulkActions,
  responsive = 'scroll',
  maxHeight,
  dense = false,
  rowClassName,
  className,
}: DataTableProps<Row>) {
  const t = useTranslations('primitives.table');
  const [localSort, setLocalSort] = useState<SortState | null>(sortProp ?? null);
  const sort = onSortChange ? (sortProp ?? null) : localSort;
  const setSort = (next: SortState | null) =>
    onSortChange ? onSortChange(next) : setLocalSort(next);

  const sorted = useMemo(() => sortRows(rows ?? [], columns, sort), [rows, columns, sort]);
  const selectable = !!selectedIds && !!onSelectedIdsChange;
  const ids = sorted.map(getRowId);
  const selectedCount = selectable ? ids.filter((id) => selectedIds.has(id)).length : 0;
  const allSelected = selectable && ids.length > 0 && selectedCount === ids.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const stack = responsive === 'stack';
  const colSpan = columns.length + (selectable ? 1 : 0);
  const showLoading = loading || rows === undefined;

  const toggleSort = (id: string) => {
    if (sort?.id !== id) return setSort({ id, direction: 'asc' });
    if (sort.direction === 'asc') return setSort({ id, direction: 'desc' });
    return setSort(null);
  };
  const toggleRow = (id: string, on: boolean) => {
    if (!selectable) return;
    const next = new Set(selectedIds);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedIdsChange(next);
  };
  const toggleAll = (on: boolean) => {
    if (!selectable) return;
    const next = new Set(selectedIds);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onSelectedIdsChange(next);
  };

  const cellPad = dense ? 'py-1.5' : 'py-2.5';

  return (
    <div data-slot="data-table" className={cn('flex min-w-0 flex-col gap-2', className)}>
      {selectable && bulkActions && selectedCount > 0 && (
        <div
          role="region"
          aria-label={t('bulkBar')}
          data-slot="data-table-bulk-bar"
          className="flex flex-wrap items-center gap-2 rounded-field bg-surface-raised px-3 py-2 text-sm"
        >
          <span className="font-medium tabular-nums" aria-live="polite">
            {t('selected', { count: selectedCount })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions(ids.filter((id) => selectedIds.has(id)))}
          </div>
          <Button size="sm" variant="ghost" className="ms-auto" onClick={() => toggleAll(false)}>
            {t('clearSelection')}
          </Button>
        </div>
      )}
      <Table
        containerClassName={cn(maxHeight && 'overflow-y-auto')}
        containerStyle={maxHeight ? { maxHeight } : undefined}
        className={cn(stack && 'max-sm:block')}
        aria-busy={showLoading || undefined}
      >
        {caption && (
          <TableCaption className={cn(!showCaption && 'sr-only', 'mt-2 text-start')}>
            {caption}
          </TableCaption>
        )}
        <TableHeader
          className={cn('sticky top-0 z-(--z-raised) bg-background', stack && 'max-sm:sr-only')}
        >
          <TableRow>
            {selectable && (
              <TableHead className="w-10">
                <Checkbox
                  aria-label={t('selectAll')}
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  disabled={ids.length === 0}
                  onCheckedChange={(v) => toggleAll(v === true)}
                />
              </TableHead>
            )}
            {columns.map((c) => {
              const active = sort?.id === c.id ? sort.direction : null;
              return (
                <TableHead
                  key={c.id}
                  scope="col"
                  aria-sort={
                    c.sortValue
                      ? active === 'asc'
                        ? 'ascending'
                        : active === 'desc'
                          ? 'descending'
                          : 'none'
                      : undefined
                  }
                  className={cn(ALIGN[c.align ?? 'start'], c.headerClassName)}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.id)}
                      className={cn(
                        '-mx-1.5 inline-flex items-center gap-1 rounded-control px-1.5 py-1 font-medium transition-colors duration-(--duration-fast) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'text-foreground',
                      )}
                    >
                      {c.header}
                      {active === 'asc' ? (
                        <ArrowUp aria-hidden className="size-3.5" />
                      ) : active === 'desc' ? (
                        <ArrowDown aria-hidden className="size-3.5" />
                      ) : (
                        <ChevronsUpDown aria-hidden className="size-3.5 opacity-50" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody className={cn(stack && 'max-sm:block')}>
          {showLoading ? (
            Array.from({ length: loadingRows }, (_, i) => (
              <TableRow key={`loading-${i}`} className="hover:bg-transparent">
                <TableCell colSpan={colSpan} className={cellPad}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))
          ) : sorted.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={colSpan}
                className="py-10 text-center whitespace-normal text-muted-foreground"
              >
                {empty ?? t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row) => {
              const id = getRowId(row);
              const selected = selectable && selectedIds.has(id);
              return (
                <TableRow
                  key={id}
                  data-state={selected ? 'selected' : undefined}
                  className={cn(
                    stack &&
                      'max-sm:mb-2 max-sm:grid max-sm:gap-1 max-sm:rounded-field max-sm:border max-sm:border-border max-sm:p-3',
                    rowClassName?.(row),
                  )}
                >
                  {selectable && (
                    <TableCell className={cn('w-10', cellPad, stack && 'max-sm:p-0')}>
                      <Checkbox
                        aria-label={
                          rowLabel ? t('selectRow', { name: rowLabel(row) }) : t('selectThisRow')
                        }
                        checked={selected}
                        onCheckedChange={(v) => toggleRow(id, v === true)}
                      />
                    </TableCell>
                  )}
                  {columns.map((c) => {
                    const Cell = c.rowHeader ? TableRowHeader : TableCell;
                    return (
                      <Cell
                        key={c.id}
                        className={cn(
                          ALIGN[c.align ?? 'start'],
                          cellPad,
                          stack &&
                            'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:p-0 max-sm:text-end max-sm:whitespace-normal',
                          stack && c.hideWhenStacked && 'max-sm:hidden',
                          c.className,
                        )}
                      >
                        {stack && (
                          <span aria-hidden className="text-xs text-muted-foreground sm:hidden">
                            {c.mobileLabel ?? c.header}
                          </span>
                        )}
                        {c.cell(row)}
                      </Cell>
                    );
                  })}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
