'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ExternalLink, Hash, Repeat2, ShieldAlert, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { Stat } from '../primitives';
import { ItemForm } from './plan-editor';
import { ItemCopyEditor } from './item-copy';
import {
  CappedNotice,
  CreatesAtText,
  HoldNotice,
  ItemMeta,
  ItemStatusBadge,
  ReasonText,
} from './plan-parts';
import {
  canChangeScheduled,
  createsLaterCount,
  groupByDay,
  type Plan,
  type PlanItem,
} from './plan-model';
import { useLiveStatus } from '../live/live-projects-context';
import { StatusChip } from '../live/status-chip';

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// 20.9 — a plan that is generating, scheduled or finished: counts by status, a notice while the
// runner is held (kill switch, spending limit, daily limit), every post with its status and a
// link to its project, and the review window — swap a post for another topic or remove it before
// its time — plus "Cancel plan".

const STATS = ['SCHEDULED', 'GENERATING', 'READY', 'HELD', 'FAILED', 'POSTED'] as const;

export function PlanView({ plan, onChange }: { plan: Plan; onChange: () => Promise<void> }) {
  const t = useTranslations('plans.view');
  const ts = useTranslations('plans.itemStatus');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [cancelling, setCancelling] = useState(false);
  const now = Date.now();
  const open = plan.status === 'GENERATING' || plan.status === 'SCHEDULED';
  // 23.6: queued posts waiting for their creation time are not being made yet.
  const waiting = createsLaterCount(plan.items, now);
  const generating = plan.counts.GENERATING + Math.max(0, plan.counts.QUEUED - waiting);

  async function call(path: string, method: Method, body?: unknown, success?: string) {
    try {
      await api(path, { method, body, idempotencyKey: newIdempotencyKey() });
      if (success) toast.success(success);
      await onChange();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        role="group"
        aria-label={t('statsAria')}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        {STATS.map((s) => (
          <Stat
            key={s}
            label={ts(s)}
            value={f.number(s === 'GENERATING' ? generating : plan.counts[s])}
          />
        ))}
      </div>
      <HoldNotice reason={open ? plan.holdReason : null} />
      <CappedNotice plan={plan} />
      {plan.counts.HELD > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {t('heldNote', { count: plan.counts.HELD })}
        </p>
      )}
      {open && <p className="text-sm text-muted-foreground">{t('reviewWindow')}</p>}
      {waiting > 0 && (
        <p className="text-xs text-muted-foreground">{t('createsLater', { count: waiting })}</p>
      )}

      <ol aria-label={t('daysAria')} className="flex flex-col gap-6">
        {groupByDay(plan.items, plan.timezone).map(({ day, items }) => (
          <li key={day} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              {f.date(`${day}T12:00:00Z`, { dateStyle: 'full', timeZone: 'UTC' })}
            </h3>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  plan={plan}
                  item={item}
                  now={now}
                  changeable={open && canChangeScheduled(item, now)}
                  call={call}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {open && (
        <div>
          <Button variant="outline" onClick={() => setCancelling(true)}>
            {t('cancelPlan')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('cancelPlan')}
        description={t('cancelConfirm')}
        confirmLabel={t('cancelPlan')}
        onConfirm={() =>
          call(`/content-plans/${plan.id}/cancel`, 'POST', undefined, t('cancelled'))
        }
      />
    </div>
  );
}

type Call = (path: string, method: Method, body?: unknown, success?: string) => Promise<boolean>;

/** 24.2: the post's live stage and ETA while its project is being made (SSE). */
function LiveChip({ projectId }: { projectId: string }) {
  const live = useLiveStatus(projectId);
  return live ? <StatusChip live={live} /> : null;
}

function ItemRow({
  plan,
  item,
  now,
  changeable,
  call,
}: {
  plan: Plan;
  item: PlanItem;
  now: number;
  changeable: boolean;
  call: Call;
}) {
  const t = useTranslations('plans.view');
  const th = useTranslations('hashtags.plan');
  const [swapping, setSwapping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const path = `/content-plans/${plan.id}/items/${item.id}`;
  const faded = item.status === 'REMOVED' || item.status === 'SKIPPED';
  return (
    <li
      className={
        faded
          ? 'rounded-lg border border-dashed border-border p-3 opacity-70'
          : 'rounded-lg border border-border p-3'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <ItemMeta item={item} timezone={plan.timezone} />
          <p className="mt-1 font-medium">{item.title}</p>
          <CreatesAtText item={item} timezone={plan.timezone} now={now} />
          <ReasonText reason={item.statusReason} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <ItemStatusBadge status={item.status} />
          {item.projectId && <LiveChip projectId={item.projectId} />}
        </div>
      </div>
      {swapping ? (
        <ItemForm
          item={item}
          saveLabel={t('swapSubmit')}
          onCancel={() => setSwapping(false)}
          onSave={async (body) => {
            const done = await call(path, 'PATCH', body, t('swapped'));
            if (done) setSwapping(false);
          }}
        />
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.projectId && (
            <Button asChild size="sm" variant="ghost">
              <Link
                href={`/projects/${item.projectId}`}
                aria-label={t('openAria', { title: item.title })}
              >
                <ExternalLink /> {t('open')}
              </Link>
            </Button>
          )}
          {changeable && (
            <>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={copyOpen}
                aria-label={th('openAria', { title: item.title })}
                onClick={() => setCopyOpen((o) => !o)}
              >
                <Hash /> {th('open')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('swapAria', { title: item.title })}
                onClick={() => setSwapping(true)}
              >
                <Repeat2 /> {t('swap')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('removeAria', { title: item.title })}
                onClick={() => setRemoving(true)}
              >
                <Trash2 /> {t('remove')}
              </Button>
            </>
          )}
        </div>
      )}
      {copyOpen && !swapping && (
        <ItemCopyEditor plan={plan} item={item} call={call} onDone={() => setCopyOpen(false)} />
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('removeAria', { title: item.title })}
        description={t('removeConfirm')}
        confirmLabel={t('remove')}
        onConfirm={() => call(path, 'DELETE', undefined, t('removedToast'))}
      />
    </li>
  );
}
