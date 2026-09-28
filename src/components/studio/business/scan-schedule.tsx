'use client';

import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';

// BACKLOG 13.10 (Addendum A6.6) — the "next scheduled scan" line under the scan form:
// GET /businesses/:id/scans/schedule.

export interface ScanSchedule {
  nextScanAt: string | null;
  nextStockRefreshAt: string | null;
  lastSkippedUnchangedAt: string | null;
  lastScanAt: string | null;
  intervalDays: number;
}

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };

export function ScanScheduleLine({ businessId }: { businessId: string }) {
  const t = useTranslations('business.schedule');
  const f = useFormat();
  const { data } = useApi<ScanSchedule>(
    `/businesses/${encodeURIComponent(businessId)}/scans/schedule`,
  );
  if (!data || typeof data.intervalDays !== 'number') return null;
  const parts: string[] = [];
  if (data.nextScanAt)
    parts.push(t('next', { date: f.date(data.nextScanAt, DAY), days: data.intervalDays }));
  else parts.push(t('notYet'));
  if (data.lastSkippedUnchangedAt)
    parts.push(t('lastSkipped', { date: f.date(data.lastSkippedUnchangedAt) }));
  if (data.nextStockRefreshAt)
    parts.push(t('stock', { date: f.date(data.nextStockRefreshAt, DAY) }));
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground" aria-label={t('aria')}>
      <CalendarClock className="mt-px size-3.5 shrink-0" />
      <span>{parts.join(' ')}</span>
    </p>
  );
}
