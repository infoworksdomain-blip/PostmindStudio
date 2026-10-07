'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedControl } from '@/components/ui/segmented-control';
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

  return (
    <section
      aria-labelledby="posting-plan-heading"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
    >
      <h3 id="posting-plan-heading" className="flex items-center gap-2 font-display text-xl">
        <CalendarRange aria-hidden className="size-5 text-foreground-secondary" strokeWidth={1.5} />
        {t('title')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      <fieldset disabled={saving} className="flex flex-col gap-3">
        <legend id={`${id}-mode-legend`} className="sr-only">
          {ts('howOften')}
        </legend>
        <SegmentedControl<PostingSchedule['mode']>
          aria-labelledby={`${id}-mode-legend`}
          className="self-start"
          options={[
            { value: 'daily', label: ts('modeDaily') },
            { value: 'weekly', label: ts('modeWeekly') },
          ]}
          value={s.mode}
          onChange={(mode) => {
            if (mode === 'custom') return;
            setDraft(mode === 'weekly' ? withDefaultDays(setMode(s, mode)) : setMode(s, mode));
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-count`} className="text-sm font-medium">
            {s.mode === 'weekly' ? ts('postsPerWeek') : ts('postsPerDay')}
          </label>
          <NativeSelect
            id={`${id}-count`}
            wrapperClassName="w-24"
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
          </NativeSelect>
        </div>
        <p className="text-xs text-muted-foreground">
          {valid ? summary(s, resolveSchedule(s)) : null}
        </p>
        <Button size="sm" className="self-start" onClick={save} disabled={!valid} loading={saving}>
          {t('save')}
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
