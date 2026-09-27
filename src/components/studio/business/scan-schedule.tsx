'use client';

import { CalendarClock } from 'lucide-react';
import { useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';

// BACKLOG 13.10 (Addendum A6.6) — the "next scheduled scan" line under the scan form:
// GET /businesses/:id/scans/schedule.

export interface ScanSchedule {
  nextScanAt: string | null;
  nextStockRefreshAt: string | null;
  lastSkippedUnchangedAt: string | null;
  lastScanAt: string | null;
  intervalDays: number;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export function ScanScheduleLine({ businessId }: { businessId: string }) {
  const { data } = useApi<ScanSchedule>(
    `/businesses/${encodeURIComponent(businessId)}/scans/schedule`,
  );
  if (!data || typeof data.intervalDays !== 'number') return null;
  const parts: string[] = [];
  if (data.nextScanAt)
    parts.push(
      `Next automatic rescan ${day(data.nextScanAt)} (every ${data.intervalDays} days; skipped if your site hasn’t changed).`,
    );
  else parts.push('Automatic rescans start after your first successful scan.');
  if (data.lastSkippedUnchangedAt)
    parts.push(`Last check ${formatDate(data.lastSkippedUnchangedAt)}: no changes, so no rescan.`);
  if (data.nextStockRefreshAt)
    parts.push(`Stock photos refresh weekly — next ${day(data.nextStockRefreshAt)}.`);
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground" aria-label="Scan schedule">
      <CalendarClock className="mt-px size-3.5 shrink-0" />
      <span>{parts.join(' ')}</span>
    </p>
  );
}
