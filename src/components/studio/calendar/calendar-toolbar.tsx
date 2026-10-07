'use client';

import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useFormat } from '@/lib/client/format';
import {
  CALENDAR_VIEWS,
  hasFilters,
  SOURCE_FILTERS,
  STATUS_FILTERS,
  type CalendarFilters,
  type CalendarView,
  type SourceFilter,
  type StatusFilter,
} from './calendar-view';

// BACKLOG 25.9 — the calendar's toolbar: the period title, previous / today / next, the view
// switcher (Month / Week / Day, kept in the URL) and the platform, status and source filters
// (client side over what is loaded, also in the URL).

const NAV_LABELS = {
  month: { previous: 'previousMonth', next: 'nextMonth' },
  week: { previous: 'previousWeek', next: 'nextWeek' },
  day: { previous: 'previousDay', next: 'nextDay' },
} as const;

export interface CalendarToolbarProps {
  title: string;
  view: CalendarView;
  refreshing: boolean;
  onView: (view: CalendarView) => void;
  onShift: (delta: -1 | 1) => void;
  onToday: () => void;
}

export function CalendarToolbar({
  title,
  view,
  refreshing,
  onView,
  onShift,
  onToday,
}: CalendarToolbarProps) {
  const t = useTranslations('calendar');
  const labels = NAV_LABELS[view];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2
        className="flex min-w-0 items-center gap-2 text-2xl leading-tight font-semibold tracking-tight sm:text-3xl"
        aria-live="polite"
      >
        {title}
        {refreshing && (
          <Loader2
            aria-label={t('refreshing')}
            className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        )}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<CalendarView>
          label={t('views.label')}
          size="sm"
          value={view}
          onChange={onView}
          options={CALENDAR_VIEWS.map((v) => ({ value: v, label: t(`views.${v}`) }))}
        />
        <div className="flex items-center gap-1">
          <IconButton
            variant="outline"
            size="icon-sm"
            label={t(labels.previous)}
            onClick={() => onShift(-1)}
          >
            <ChevronLeft className="rtl:-scale-x-100" />
          </IconButton>
          <Button variant="outline" size="sm" onClick={onToday}>
            {t('today')}
          </Button>
          <IconButton
            variant="outline"
            size="icon-sm"
            label={t(labels.next)}
            onClick={() => onShift(1)}
          >
            <ChevronRight className="rtl:-scale-x-100" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

export interface CalendarFilterBarProps {
  filters: CalendarFilters;
  platforms: readonly string[];
  shown: number;
  total: number;
  onChange: (filters: Partial<CalendarFilters>) => void;
  onClear: () => void;
}

export function CalendarFilterBar({
  filters,
  platforms,
  shown,
  total,
  onChange,
  onClear,
}: CalendarFilterBarProps) {
  const t = useTranslations('calendar.filters');
  const ts = useTranslations('calendar.filters.status');
  const tsrc = useTranslations('calendar.filters.source');
  const f = useFormat();
  const active = hasFilters(filters);
  return (
    <div
      role="group"
      aria-label={t('label')}
      className="grid w-full grid-cols-3 items-center gap-2 sm:flex sm:w-auto sm:flex-wrap"
      data-testid="calendar-filters"
    >
      <NativeSelect
        size="sm"
        aria-label={t('platformLabel')}
        wrapperClassName="w-full sm:w-auto"
        value={filters.platform ?? ''}
        onChange={(e) => onChange({ platform: e.target.value || null })}
      >
        <option value="">{t('allPlatforms')}</option>
        {platforms.map((p) => (
          <option key={p} value={p}>
            {f.platform(p)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        size="sm"
        aria-label={t('statusLabel')}
        wrapperClassName="w-full sm:w-auto"
        value={filters.status ?? ''}
        onChange={(e) => onChange({ status: (e.target.value || null) as StatusFilter | null })}
      >
        <option value="">{t('anyStatus')}</option>
        {STATUS_FILTERS.map((s) => (
          <option key={s} value={s}>
            {ts(s)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        size="sm"
        aria-label={t('sourceLabel')}
        wrapperClassName="w-full sm:w-auto"
        value={filters.source ?? ''}
        onChange={(e) => onChange({ source: (e.target.value || null) as SourceFilter | null })}
      >
        <option value="">{t('anySource')}</option>
        {SOURCE_FILTERS.map((s) => (
          <option key={s} value={s}>
            {tsrc(s)}
          </option>
        ))}
      </NativeSelect>
      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="col-span-3 justify-self-start"
        >
          <X /> {t('clear')}
        </Button>
      )}
      {/* Always mounted, so a filter change is announced. */}
      <p role="status" className="col-span-3 text-xs text-muted-foreground">
        {active ? t('showing', { shown, total }) : ''}
      </p>
    </div>
  );
}
