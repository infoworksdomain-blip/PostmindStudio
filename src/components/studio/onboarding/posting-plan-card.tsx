'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { matchPreset, presetSlots, type DripPresetId } from '@/lib/studio/drip-presets';
import { defaultZone, PostingPlanPresets, type DripQueueView } from '../calendar/drip-queue';

// 20.3 — "Plan your month" on the last onboarding step: one click saves a posting plan as the
// business's drip queue (PUT /businesses/:id/drip-queue, turned on), so videos set to the next
// free slot fill the month. The times can be changed in the calendar.

export function PostingPlanCard({ businessId }: { businessId: string }) {
  const t = useTranslations('onboarding.plan');
  const tp = useTranslations('calendar.drip.presets');
  const errorMessage = useErrorMessage();
  const path = `/businesses/${encodeURIComponent(businessId)}/drip-queue`;
  const { data, mutate } = useApi<{ dripQueue: DripQueueView | null }>(path);
  const [saving, setSaving] = useState(false);
  const queue = data?.dripQueue ?? null;
  const current = queue?.enabled ? matchPreset(queue.slots) : null;

  async function pick(id: DripPresetId) {
    setSaving(true);
    try {
      await api(path, {
        method: 'PUT',
        idempotencyKey: newIdempotencyKey(),
        body: {
          slots: presetSlots(id, queue?.slots[0]?.timezone ?? defaultZone()),
          platforms: queue?.platforms ?? [],
          enabled: true,
        },
      });
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
        <CalendarRange className="size-5 text-primary" strokeWidth={1.5} />
        {t('title')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      <PostingPlanPresets current={current} onPick={(id) => void pick(id)} disabled={saving} />
      <p aria-live="polite" className="text-sm">
        {current ? t('saved', { plan: tp(current) }) : null}{' '}
        <Link href="/calendar" className="underline underline-offset-2">
          {t('openCalendar')}
        </Link>
      </p>
    </section>
  );
}
