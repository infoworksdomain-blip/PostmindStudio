'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import {
  DRIP_PRESET_IDS,
  matchPreset,
  presetSlots,
  type DripPresetId,
} from '@/lib/studio/drip-presets';
import { cn } from '@/lib/utils';
import { useBusiness } from '../business-context';
import { weekdayNames } from './month';

// 15.A5 — the business's drip queue under the calendar (spec 3.1 "drip queue", 9.9 stagger):
// weekly posting slots in a time zone; approved SCHEDULED videos without a start time take the
// next free slot and their platforms are staggered from there.
// GET/PUT /api/studio/businesses/:id/drip-queue.
// 20.3: one-click plans ("3 a week", "5 a week", "Every day") fill the slots in the queue's time
// zone (or the viewer's); they can be edited before "Save slots", which turns the queue on.

export interface DripSlot {
  weekday: number;
  time: string;
  timezone: string;
}

export interface DripQueueView {
  slots: DripSlot[];
  platforms: string[];
  enabled: boolean;
  staggerMinutes: number;
  nextSlotAt: string | null;
  queued: number;
  upcoming: Array<{ slotAt: string; projectId: string }>;
}

export function defaultZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The one-click plan buttons; `current` is pressed. */
export function PostingPlanPresets({
  current,
  onPick,
  disabled = false,
}: {
  current: DripPresetId | null;
  onPick: (id: DripPresetId) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('calendar.drip');
  return (
    <div role="group" aria-label={t('presetsLabel')} className="flex flex-wrap gap-2">
      {DRIP_PRESET_IDS.map((id) => (
        <Button
          key={id}
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={current === id}
          disabled={disabled}
          className={cn(current === id && 'border-foreground bg-secondary')}
          onClick={() => onPick(id)}
        >
          {t(`presets.${id}`)}
        </Button>
      ))}
    </div>
  );
}

export function DripQueuePanel({ onSaved }: { onSaved?: () => void } = {}) {
  const t = useTranslations('calendar.drip');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const weekdays = useMemo(() => weekdayNames(f.locale, 'long'), [f.locale]);
  const { businessId } = useBusiness();
  const path = businessId ? `/businesses/${encodeURIComponent(businessId)}/drip-queue` : null;
  const { data, mutate } = useApi<{ dripQueue: DripQueueView | null }>(path);
  const [draft, setDraft] = useState<DripSlot[] | null>(null);
  const [saving, setSaving] = useState(false);
  /** 20.3: how many slots a plan just filled in (announced until saved). */
  const [filled, setFilled] = useState<number | null>(null);
  if (!businessId) return null;
  const queue = data?.dripQueue ?? null;
  const slots = draft ?? queue?.slots ?? [];

  const pickPreset = (id: DripPresetId) => {
    const next = presetSlots(id, slots[0]?.timezone ?? defaultZone());
    setDraft(next);
    setFilled(next.length);
  };

  const change = (i: number, patch: Partial<DripSlot>) =>
    setDraft(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  async function save() {
    if (!path) return;
    setSaving(true);
    try {
      await api(path, {
        method: 'PUT',
        idempotencyKey: newIdempotencyKey(),
        body: { slots, platforms: queue?.platforms ?? [], enabled: true },
      });
      toast.success(t('saved'));
      setDraft(null);
      setFilled(null);
      await mutate();
      onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

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
      <div className="mt-3 flex flex-col gap-1.5">
        <p className="text-sm font-medium">{t('presetsLabel')}</p>
        <PostingPlanPresets current={matchPreset(slots)} onPick={pickPreset} disabled={saving} />
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {filled !== null && draft ? t('presetFilled', { count: filled }) : t('presetsHint')}
        </p>
      </div>
      {queue && !queue.enabled && !draft && (
        <p className="mt-2 text-sm text-muted-foreground">{t('off')}</p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
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
              onClick={() => setDraft(slots.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setDraft([...slots, { weekday: 1, time: '09:00', timezone: defaultZone() }])
          }
        >
          <Plus /> {t('addSlot')}
        </Button>
        {(draft || (queue && !queue.enabled)) && (
          <Button size="sm" onClick={save} disabled={saving || slots.length === 0}>
            {saving && <Loader2 className="animate-spin" />} {t('saveSlots')}
          </Button>
        )}
      </div>
    </section>
  );
}
