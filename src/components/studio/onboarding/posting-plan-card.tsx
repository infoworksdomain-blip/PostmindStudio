'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { CalendarRange, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import {
  defaultSchedule,
  MAX_POSTS_PER_DAY,
  MAX_POSTS_PER_WEEK,
  resolveSchedule,
  scheduleProblems,
  type PostingSchedule,
} from '@/lib/studio/posting-schedule';
import { cn } from '@/lib/utils';
import type { DripQueueView } from '../calendar/drip-queue';
import {
  initialSchedule,
  setMode,
  setPostsPerDay,
  setPostsPerWeek,
  viewerZone,
  withDefaultDays,
} from '../calendar/schedule-model';
import { useScheduleSummary } from '../calendar/schedule-preview';

// 20.3 — "Plan your month" on the last onboarding step: saves a posting plan as the business's
// drip queue (PUT /businesses/:id/drip-queue, turned on), so videos set to the next free slot fill
// the month. 20.14: the same simple choices as the calendar's schedule editor — Every day (1–4
// posts a day) or N posts a week — with the system's times (kept if the owner chose their own
// in the calendar); everything else is changed in the calendar.

const SELECT =
  'h-9 w-24 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function PostingPlanCard({ businessId }: { businessId: string }) {
  const t = useTranslations('onboarding.plan');
  const ts = useTranslations('calendar.drip.schedule');
  const f = useFormat();
  const id = useId();
  const summary = useScheduleSummary();
  const errorMessage = useErrorMessage();
  const path = `/businesses/${encodeURIComponent(businessId)}/drip-queue`;
  const { data, mutate } = useApi<{ dripQueue: DripQueueView | null }>(path);
  const [draft, setDraft] = useState<PostingSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const queue = data?.dripQueue ?? null;
  const base = useMemo(() => {
    const s = initialSchedule(queue);
    return s.mode === 'custom' ? defaultSchedule(s.timezone || viewerZone()) : s;
  }, [queue]);
  const s = draft ?? base;
  const valid = scheduleProblems(s).length === 0;
  const saved =
    queue?.enabled && queue.slots.length ? summary(initialSchedule(queue), queue.slots) : null;

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      await api(path, {
        method: 'PUT',
        idempotencyKey: newIdempotencyKey(),
        body: {
          schedule: s,
          slots: resolveSchedule(s),
          platforms: queue?.platforms ?? [],
          enabled: true,
        },
      });
      setDraft(null);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const pill = (checked: boolean) =>
    cn(
      'cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
      checked
        ? 'border-foreground bg-secondary'
        : 'border-border text-muted-foreground hover:text-foreground',
    );

  return (
    <section
      aria-labelledby="posting-plan-heading"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
    >
      <h3 id="posting-plan-heading" className="flex items-center gap-2 font-display text-xl">
        <CalendarRange className="size-5 text-primary" strokeWidth={1.5} />
        {t('title')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      <fieldset disabled={saving} className="flex flex-col gap-3">
        <legend className="sr-only">{ts('howOften')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['daily', 'weekly'] as const).map((mode) => (
            <label key={mode} className={pill(s.mode === mode)}>
              <input
                type="radio"
                name={`${id}-mode`}
                className="sr-only"
                checked={s.mode === mode}
                onChange={() =>
                  setDraft(mode === 'weekly' ? withDefaultDays(setMode(s, mode)) : setMode(s, mode))
                }
              />
              {mode === 'daily' ? ts('modeDaily') : ts('modeWeekly')}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-count`} className="text-sm font-medium">
            {s.mode === 'weekly' ? ts('postsPerWeek') : ts('postsPerDay')}
          </label>
          <select
            id={`${id}-count`}
            className={SELECT}
            value={s.mode === 'weekly' ? s.postsPerWeek : s.postsPerDay}
            onChange={(e) => {
              const n = Number(e.target.value);
              setDraft(
                s.mode === 'weekly' ? withDefaultDays(setPostsPerWeek(s, n)) : setPostsPerDay(s, n),
              );
            }}
          >
            {Array.from(
              { length: s.mode === 'weekly' ? MAX_POSTS_PER_WEEK : MAX_POSTS_PER_DAY },
              (_, i) => i + 1,
            ).map((n) => (
              <option key={n} value={n}>
                {f.count(n)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          {valid ? summary(s, resolveSchedule(s)) : null}
        </p>
        <Button size="sm" className="self-start" onClick={save} disabled={saving || !valid}>
          {saving && <Loader2 className="animate-spin" />} {t('save')}
        </Button>
      </fieldset>
      <p aria-live="polite" className="text-sm">
        {saved ? t('saved', { plan: saved }) : null}{' '}
        <Link href="/calendar" className="underline underline-offset-2">
          {t('openCalendar')}
        </Link>
      </p>
    </section>
  );
}
