'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarX2, Loader2, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, useErrorMessage } from '@/lib/client/api';
import type { ScheduleIssue } from '../automation/automation';

// 20.3 — an approved SCHEDULED project that got no drip slot (automation/outbox.ts
// metadata.scheduleIssue) says so instead of silently posting nothing: why, where to add posting
// times, and "Try again" (POST /projects/:id/auto-publish/retry plans it against the current
// queue). Picking a date on the Publish tab always works too.

interface RetryResponse {
  requeued: number;
  scheduled: number;
  unscheduled: ScheduleIssue['reason'] | null;
}

export function ScheduleNotice({
  projectId,
  issue,
  onChanged,
}: {
  projectId: string;
  issue: ScheduleIssue;
  onChanged?: () => void;
}) {
  const t = useTranslations('review.schedule');
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const weeks = Math.floor(issue.horizonDays / 7);

  const retry = async () => {
    setPending(true);
    try {
      const out = await api<RetryResponse>(
        `/projects/${encodeURIComponent(projectId)}/auto-publish/retry`,
        { method: 'POST', body: {} },
      );
      if (out.scheduled > 0) {
        toast.success(t('retried', { count: out.scheduled }));
        onChanged?.();
      } else toast.error(t('stillNone'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
    >
      <p className="flex items-start gap-2">
        <CalendarX2 className="mt-0.5 size-4 shrink-0 text-warning-foreground" strokeWidth={1.5} />
        <span>{t(`reasons.${issue.reason}`, { weeks })}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href="/calendar">{t('openCalendar')}</Link>
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void retry()}>
          {pending ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {t('retry')}
        </Button>
      </div>
    </div>
  );
}
