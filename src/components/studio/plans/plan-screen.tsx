'use client';

import Link from 'next/link';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarDays, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, PageHeader } from '../primitives';
import { PlanEditor } from './plan-editor';
import { PlanStatusBadge } from './plan-parts';
import { PlanView } from './plan-view';
import { writtenCount, type Plan } from './plan-model';
import { idsKey } from '../live/live-model';
import { LiveProjectsProvider } from '../live/live-projects-context';
import { useLiveRefetch } from '../live/use-live-refetch';

// 20.9 — /plans/:id: drafting progress while Claude writes (polled), the editor for a DRAFT, and
// the plan view (item statuses, review window, cancel) once it is generating or scheduled.
// 24.2: live status chips on its posts (SSE), polling only when the live stream is unavailable.

const DRAFTING_POLL_MS = 3_000;
const RUNNING_POLL_MS = 15_000;

export function planRange(plan: Pick<Plan, 'startDate' | 'days'>): { start: string; end: string } {
  const start = `${plan.startDate}T12:00:00Z`;
  const end = new Date(Date.parse(start) + (plan.days - 1) * 86_400_000).toISOString();
  return { start, end };
}

export function PlanScreen({ planId }: { planId: string }) {
  const t = useTranslations('plans');
  const f = useFormat();
  // 24.2: while the live stream is open, a generating plan is refreshed by its posts' events
  // instead of every RUNNING_POLL_MS (drafting is not project work, so it still polls).
  const liveOpen = useRef(false);
  const { data, error, mutate } = useApi<{ plan: Plan }>(`/content-plans/${planId}`, undefined, {
    refreshInterval: (latest) =>
      latest?.plan.status === 'DRAFTING'
        ? DRAFTING_POLL_MS
        : latest?.plan.status === 'GENERATING' && !liveOpen.current
          ? RUNNING_POLL_MS
          : 0,
  });
  const live = useLiveRefetch(
    idsKey((data?.plan.items ?? []).map((i) => i.projectId)),
    () => void mutate(),
    liveOpen,
  );
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return <Skeleton aria-label={t('loading')} className="h-96 rounded-xl" />;
  const plan = data.plan;
  const range = planRange(plan);
  const day = (iso: string) => f.date(iso, { dateStyle: 'medium', timeZone: 'UTC' });
  const refresh = async () => {
    await mutate();
  };
  return (
    <LiveProjectsProvider value={live}>
      <PageHeader
        eyebrow={t('new.eyebrow')}
        title={t('editor.title', { start: day(range.start), end: day(range.end) })}
        description={<PlanStatusBadge status={plan.status} />}
        actions={
          <Button asChild variant="outline">
            <Link href="/calendar">
              <CalendarDays /> {t('view.calendar')}
            </Link>
          </Button>
        }
      />
      {plan.status === 'DRAFTING' ? (
        <Drafting plan={plan} />
      ) : plan.status === 'DRAFT' ? (
        <PlanEditor plan={plan} onChange={refresh} />
      ) : (
        <PlanView plan={plan} onChange={refresh} />
      )}
    </LiveProjectsProvider>
  );
}

function Drafting({ plan }: { plan: Plan }) {
  const t = useTranslations('plans.drafting');
  const written = writtenCount(plan.items);
  const total = plan.items.length;
  return (
    <section
      aria-labelledby="plan-drafting"
      className="flex flex-col gap-3 rounded-xl border border-border p-6"
    >
      <h2 id="plan-drafting" className="flex items-center gap-2 font-display text-2xl">
        <Loader2 className="size-5 animate-spin text-primary" aria-hidden /> {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      <Progress
        value={total ? Math.round((written / total) * 100) : 0}
        aria-label={t('progress', { written, total })}
      />
      <p className="tabular text-sm" aria-live="polite">
        {t('progress', { written, total })}
      </p>
    </section>
  );
}
