'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { useBusiness } from '../business-context';

// 15.A5 — the business's drip queue under the calendar (spec 3.1 "drip queue", 9.9 stagger):
// weekly posting slots in a time zone; approved SCHEDULED videos without a start time take the
// next free slot and their platforms are staggered from there.
// GET/PUT /api/studio/businesses/:id/drip-queue.

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

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

function defaultZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function DripQueuePanel() {
  const { businessId } = useBusiness();
  const path = businessId ? `/businesses/${encodeURIComponent(businessId)}/drip-queue` : null;
  const { data, mutate } = useApi<{ dripQueue: DripQueueView | null }>(path);
  const [draft, setDraft] = useState<DripSlot[] | null>(null);
  const [saving, setSaving] = useState(false);
  if (!businessId) return null;
  const queue = data?.dripQueue ?? null;
  const slots = draft ?? queue?.slots ?? [];

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
      toast.success('Drip queue saved.');
      setDraft(null);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="drip-heading" className="mt-8 rounded-xl border border-border p-4">
      <h3 id="drip-heading" className="font-display text-xl">
        Drip queue
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Approved videos set to “Schedule” with no date go out in the next free slot; each platform
        follows {queue?.staggerMinutes ?? 30} minutes after the last.
      </p>
      {queue?.nextSlotAt && (
        <p className="mt-2 text-sm">
          Next free slot: <strong>{formatDate(queue.nextSlotAt)}</strong> · {queue.queued} queued
        </p>
      )}
      {queue && queue.upcoming.length > 0 && (
        <ul aria-label="Drip slots taken" className="mt-2 flex flex-wrap gap-2 text-xs">
          {queue.upcoming.map((u) => (
            <li key={`${u.projectId}-${u.slotAt}`} className="rounded bg-muted px-2 py-1">
              {formatDate(u.slotAt)}
            </li>
          ))}
        </ul>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {slots.map((slot, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Slot ${i + 1} day`}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              value={slot.weekday}
              onChange={(e) => change(i, { weekday: Number(e.target.value) })}
            >
              {WEEKDAYS.map((d, n) => (
                <option key={d} value={n}>
                  {d}
                </option>
              ))}
            </select>
            <Input
              aria-label={`Slot ${i + 1} time`}
              type="time"
              className="w-32"
              value={slot.time}
              onChange={(e) => change(i, { time: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">{slot.timezone}</span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove slot ${i + 1}`}
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
          <Plus /> Add slot
        </Button>
        {draft && (
          <Button size="sm" onClick={save} disabled={saving || slots.length === 0}>
            {saving && <Loader2 className="animate-spin" />} Save slots
          </Button>
        )}
      </div>
    </section>
  );
}
