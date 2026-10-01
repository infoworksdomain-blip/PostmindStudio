'use client';

import { ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import {
  MAX_POSTS_PER_WEEK,
  MAX_POSTS_PER_DAY,
  MIN_POST_GAP_MINUTES,
  slotsWithinDailyCap,
  type DripSlot,
  type PostingSchedule,
} from '@/lib/studio/posting-schedule';
import { useBusiness } from '../business-context';
import { weekdayNames } from './month';
import { PostingScheduleEditor } from './schedule-editor';
import { initialSchedule, resolveDraft, viewerZone } from './schedule-model';
import { SchedulePreview } from './schedule-preview';

// 15.A5 — the business's drip queue under the calendar (spec 3.1 "drip queue", 9.9 stagger):
// weekly posting slots in a time zone; approved SCHEDULED videos without a start time take the
// next free slot and their platforms are staggered from there.
// GET/PUT /api/studio/businesses/:id/drip-queue.
// 20.14: a posting-schedule editor replaces the 20.3 one-click plans: Every day (1–4 a day) or
// N a week on chosen days, times chosen / picked by the system / at intervals, a time zone, a
// summary and the next 7 days. The per-slot list stays under "Advanced"; editing it there makes
// the schedule custom. The server resolves daily/weekly schedules itself (posting-schedule.ts).

export type { DripSlot };

export interface DripQueueView {
  slots: DripSlot[];
  /** 20.14: absent from older servers; null for queues saved before 20.14. */
  schedule?: PostingSchedule | null;
  platforms: string[];
  enabled: boolean;
  staggerMinutes: number;
  nextSlotAt: string | null;
  queued: number;
  upcoming: Array<{ slotAt: string; projectId: string }>;
}

/** The viewer's IANA zone (kept for older imports). */
export const defaultZone = viewerZone;

interface Draft {
  schedule: PostingSchedule;
  /** Hand-edited slots (schedule.mode 'custom'). */
  custom: DripSlot[];
}

export function DripQueuePanel({ onSaved }: { onSaved?: () => void } = {}) {
  const t = useTranslations('calendar.drip');
  const ts = useTranslations('calendar.drip.schedule');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const { businessId } = useBusiness();
  const path = businessId ? `/businesses/${encodeURIComponent(businessId)}/drip-queue` : null;
  const { data, mutate } = useApi<{ dripQueue: DripQueueView | null }>(path);
  const queue = data?.dripQueue ?? null;
  const base = useMemo<Draft>(
    () => ({ schedule: initialSchedule(queue), custom: queue?.slots ?? [] }),
    [queue],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const current = draft ?? base;
  const resolved = resolveDraft(current.schedule, current.custom);
  if (!businessId) return null;

  const customTooMany = current.schedule.mode === 'custom' && !slotsWithinDailyCap(resolved.slots);
  const canSave =
    resolved.problems.length === 0 &&
    resolved.slots.length > 0 &&
    resolved.slots.length <= MAX_POSTS_PER_WEEK &&
    !customTooMany;

  const changeSchedule = (schedule: PostingSchedule) =>
    setDraft({
      schedule,
      // A time-zone change applies to hand-edited slots too.
      custom: current.custom.map((s) => ({ ...s, timezone: schedule.timezone })),
    });

  /** Advanced edits start from the slots the schedule shows now, and make it custom. */
  const editSlots = (slots: DripSlot[]) =>
    setDraft({ schedule: { ...current.schedule, mode: 'custom' }, custom: slots });

  async function save() {
    if (!path || !canSave) return;
    setSaving(true);
    try {
      await api(path, {
        method: 'PUT',
        idempotencyKey: newIdempotencyKey(),
        body: {
          schedule: current.schedule,
          slots: resolved.slots,
          platforms: queue?.platforms ?? [],
          enabled: true,
        },
      });
      toast.success(t('saved'));
      setDraft(null);
      await mutate();
      onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const showSave = Boolean(draft) || !queue || !queue.enabled;
  return (
    <section aria-labelledby="drip-heading" className="mt-8 rounded-xl border border-border p-4">
      <h3 id="drip-heading" tabIndex={-1} className="font-display text-xl outline-none">
        {t('title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('description', { minutes: queue?.staggerMinutes ?? 30 })}
      </p>
      {queue?.nextSlotAt && (
        <p className="mt-2 text-sm">
          {t.rich('nextSlot', {
            date: f.date(queue.nextSlotAt),
            queued: queue.queued,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      )}
      {queue && queue.upcoming.length > 0 && (
        <ul aria-label={t('takenAria')} className="mt-2 flex flex-wrap gap-2 text-xs">
          {queue.upcoming.map((u) => (
            <li key={`${u.projectId}-${u.slotAt}`} className="rounded bg-muted px-2 py-1">
              {f.date(u.slotAt)}
            </li>
          ))}
        </ul>
      )}
      {queue && !queue.enabled && !draft && (
        <p className="mt-2 text-sm text-muted-foreground">{t('off')}</p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <PostingScheduleEditor
          schedule={current.schedule}
          onChange={changeSchedule}
          disabled={saving}
        />
        <div className="flex flex-col gap-3">
          {(resolved.problems.length > 0 || customTooMany) && (
            <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
              {resolved.problems.map((p) => (
                <li key={p}>
                  {ts(`problems.${p}`, { max: MAX_POSTS_PER_DAY, minutes: MIN_POST_GAP_MINUTES })}
                </li>
              ))}
              {customTooMany && (
                <li>{ts('problems.custom_too_many', { max: MAX_POSTS_PER_DAY })}</li>
              )}
            </ul>
          )}
          <SchedulePreview schedule={current.schedule} slots={canSave ? resolved.slots : []} />
          {showSave && (
            <Button size="sm" className="self-start" onClick={save} disabled={saving || !canSave}>
              {saving && <Loader2 className="animate-spin" />} {ts('save')}
            </Button>
          )}
        </div>
      </div>

      <AdvancedSlots
        slots={resolved.slots}
        timezone={current.schedule.timezone}
        onChange={editSlots}
      />
    </section>
  );
}

/** "Advanced": every weekly slot, editable one by one (the pre-20.14 list). */
function AdvancedSlots({
  slots,
  timezone,
  onChange,
}: {
  slots: DripSlot[];
  timezone: string;
  onChange: (slots: DripSlot[]) => void;
}) {
  const t = useTranslations('calendar.drip');
  const ts = useTranslations('calendar.drip.schedule');
  const f = useFormat();
  const weekdays = useMemo(() => weekdayNames(f.locale, 'long'), [f.locale]);
  const change = (i: number, patch: Partial<DripSlot>) =>
    onChange(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <details className="group mt-4 rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        {ts('advanced', { count: slots.length })}
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <p className="text-xs text-muted-foreground">{ts('advancedHint')}</p>
        <ul className="flex flex-col gap-2">
          {slots.map((slot, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <select
                aria-label={t('slotDay', { n: i + 1 })}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={slot.weekday}
                onChange={(e) => change(i, { weekday: Number(e.target.value) })}
              >
                {weekdays.map((d, n) => (
                  <option key={d} value={n}>
                    {d}
                  </option>
                ))}
              </select>
              <Input
                aria-label={t('slotTime', { n: i + 1 })}
                type="time"
                className="w-32"
                value={slot.time}
                onChange={(e) => change(i, { time: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">{slot.timezone}</span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('removeSlot', { n: i + 1 })}
                onClick={() => onChange(slots.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={slots.length >= MAX_POSTS_PER_WEEK}
          onClick={() => onChange([...slots, { weekday: 1, time: '09:00', timezone }])}
        >
          <Plus /> {t('addSlot')}
        </Button>
      </div>
    </details>
  );
}
