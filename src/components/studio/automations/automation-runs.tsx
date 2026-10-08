'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { FormatKey } from '../blitz/blitz-model';
import { StateBadge } from '../primitives';
import { CreatesAtText, ReasonText } from '../plans/plan-parts';
import { WriteGate } from '../write-gate';
import type { AutomationPeriod, AutomationSlot } from './automation-model';

// 22.5 — an automation's periods (its runs), newest first. 25.9: a timeline — one entry per run
// with its number, status, dates and how many posts went out — the latest open, older ones folded
// (a native <details>, keyboard and screen-reader friendly). Inside, the run's posts by day:
// time, format, status, title, reason, "download only" networks, and while it is in review
// "New topic", "Remove" and "Keep" (POST /automations/:id/slots/:itemId).

const LIVE_ITEM = new Set([
  'QUEUED',
  'GENERATING',
  'READY',
  'SCHEDULED',
  'POSTED',
  'PLANNED',
  'HELD',
]);

export type SlotAction = 'keep' | 'skip' | 'reroll';

export function AutomationRuns({
  periods,
  periodIndex,
  reviewing,
  busy,
  onSlot,
}: {
  periods: readonly AutomationPeriod[];
  periodIndex: number;
  reviewing: boolean;
  busy: boolean;
  onSlot: (itemId: string, action: SlotAction) => void;
}) {
  const t = useTranslations('automations');
  if (periods.length === 0)
    return <p className="text-sm text-muted-foreground">{t('detail.noPeriods')}</p>;
  return (
    <section aria-labelledby="automation-runs" className="flex flex-col gap-4">
      <h2 id="automation-runs" className="text-lg font-semibold tracking-tight">
        {t('detail.runs')}
      </h2>
      <ol className="ms-1.5 flex flex-col gap-6 border-s border-border ps-6">
        {periods.map((period, i) => (
          <RunEntry
            key={period.id}
            period={period}
            n={Math.max(1, periodIndex - i)}
            latest={i === 0}
            reviewing={reviewing && i === 0}
            busy={busy}
            onSlot={onSlot}
          />
        ))}
      </ol>
    </section>
  );
}

function RunEntry({
  period,
  n,
  latest,
  reviewing,
  busy,
  onSlot,
}: {
  period: AutomationPeriod;
  n: number;
  latest: boolean;
  reviewing: boolean;
  busy: boolean;
  onSlot: (itemId: string, action: SlotAction) => void;
}) {
  const t = useTranslations('automations');
  const tp = useTranslations('plans');
  const f = useFormat();
  const start = `${period.startDate}T12:00:00Z`;
  const end = new Date(Date.parse(start) + Math.max(0, period.days - 1) * 86_400_000).toISOString();
  const day = (iso: string) => f.date(iso, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const posted = period.items.filter((i) => i.status === 'POSTED').length;
  const id = `run-${period.id}`;
  return (
    <li className="relative" aria-labelledby={id}>
      <span
        aria-hidden
        className={cn(
          'absolute -start-[1.95rem] top-1.5 size-3 rounded-full border-2 border-background',
          latest ? 'bg-primary' : 'bg-border-strong',
        )}
      />
      <details open={latest} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <h3 id={id} className="text-base font-semibold">
            {t('detail.period', { n })}
          </h3>
          <StateBadge label={tp(`status.${period.status as 'DRAFT'}`)} tone="neutral" />
          <span className="text-sm text-muted-foreground">
            {t('detail.runRange', { start: day(start), end: day(end) })} ·{' '}
            {t('detail.runPosted', { posted, total: period.items.length })}
          </span>
          {period.holdReason === 'paused' && (
            <span className="text-xs text-muted-foreground">{tp('hold.paused')}</span>
          )}
        </summary>
        <div className="mt-4">
          {period.status === 'DRAFTING' && (
            <p role="status" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{' '}
              {t('detail.writing')}
            </p>
          )}
          <RunSlots period={period} reviewing={reviewing} busy={busy} onSlot={onSlot} />
        </div>
      </details>
    </li>
  );
}

function RunSlots({
  period,
  reviewing,
  busy,
  onSlot,
}: {
  period: AutomationPeriod;
  reviewing: boolean;
  busy: boolean;
  onSlot: (itemId: string, action: SlotAction) => void;
}) {
  const t = useTranslations('automations');
  const tb = useTranslations('blitz.deck');
  const tp = useTranslations('plans');
  const f = useFormat();
  const now = Date.now();
  const byDay = new Map<string, AutomationSlot[]>();
  for (const item of period.items) {
    const day = f.date(item.slotAt, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: period.timezone,
    });
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  return (
    <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {[...byDay.entries()].map(([day, items]) => (
        <li key={day} className="rounded-panel border border-border bg-card p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{day}</p>
          <ul className="space-y-3">
            {items.map((item) => (
              <li
                key={item.id}
                className={cn('space-y-1', !LIVE_ITEM.has(item.status) && 'opacity-60')}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="tabular text-muted-foreground">
                    {f.date(item.slotAt, {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone: period.timezone,
                    })}
                  </span>
                  {item.format && (
                    <StatusPill tone="info" size="sm">
                      {tb(`format.${item.format as FormatKey}`)}
                    </StatusPill>
                  )}
                  <span className="text-muted-foreground">
                    {tp(`itemStatus.${item.status as 'PLANNED'}`)}
                  </span>
                  {item.reviewed && (
                    <span className="text-success-foreground">{t('detail.reviewed')}</span>
                  )}
                </div>
                {item.projectId ? (
                  <Link
                    href={`/projects/${item.projectId}`}
                    className="block text-sm font-medium hover:underline"
                  >
                    {item.title || t('detail.untitled')}
                  </Link>
                ) : (
                  <p className="text-sm font-medium">{item.title || t('detail.untitled')}</p>
                )}
                <CreatesAtText item={item} timezone={period.timezone} now={now} />
                <ReasonText reason={item.statusReason} />
                {item.downloadOnly.length > 0 && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Download className="size-3" aria-hidden />
                    {t('detail.downloadOnly', {
                      platforms: f.list(item.downloadOnly.map((p) => f.platform(p))),
                    })}
                  </p>
                )}
                {reviewing && item.status === 'PLANNED' && (
                  <WriteGate>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => onSlot(item.id, 'reroll')}
                      >
                        <RefreshCw /> {t('detail.reroll')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onSlot(item.id, 'skip')}
                      >
                        <Trash2 /> {t('detail.remove')}
                      </Button>
                      {!item.reviewed && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onSlot(item.id, 'keep')}
                        >
                          {t('detail.keep')}
                        </Button>
                      )}
                    </div>
                  </WriteGate>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
