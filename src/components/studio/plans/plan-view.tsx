'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { StudioCapability } from '@/lib/rbac';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { Stat } from '../primitives';
import { useCan } from '../use-can';
import { useBulkRun } from './bulk-run';
import { PlanBulkBar, useBulkSummary } from './plan-bulk-bar';
import type { Call } from './plan-draft-item';
import { PlanItemRow } from './plan-item-row';
import { CappedNotice, HoldNotice } from './plan-parts';
import { approvableItems, canChangeScheduled, createsLaterCount, type Plan } from './plan-model';
import { PlanTimeline } from './plan-timeline';

// 20.9 — a plan that is generating, scheduled or finished: counts by status, a notice while the
// runner is held (kill switch, spending limit, daily limit), every post with its status and a
// link to its project, and the review window — swap a post for another topic or remove it before
// its time — plus "Cancel plan". 25.9: the posts sit on the week-by-week timeline; a post waiting
// for review can be approved where it is (POST /projects/:id/approve, as the review screen), and
// "Approve all waiting" approves them one after another with progress and a summary.

const STATS = ['SCHEDULED', 'GENERATING', 'READY', 'HELD', 'FAILED', 'POSTED'] as const;

export function PlanView({ plan, onChange }: { plan: Plan; onChange: () => Promise<void> }) {
  const t = useTranslations('plans.view');
  const ts = useTranslations('plans.itemStatus');
  const tb = useTranslations('plans.bulk');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const summary = useBulkSummary();
  const bulk = useBulkRun();
  const mayApprove = useCan(StudioCapability.ProjectApprove);
  const [cancelling, setCancelling] = useState(false);
  const now = Date.now();
  const open = plan.status === 'GENERATING' || plan.status === 'SCHEDULED';
  // 23.6: queued posts waiting for their creation time are not being made yet.
  const waiting = createsLaterCount(plan.items, now);
  const generating = plan.counts.GENERATING + Math.max(0, plan.counts.QUEUED - waiting);
  const approvable = mayApprove ? approvableItems(plan.items) : [];

  const call: Call = async (path, method, body, success) => {
    try {
      await api(path, { method, body, idempotencyKey: newIdempotencyKey() });
      if (success) toast.success(success);
      await onChange();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const approveAll = async () => {
    const result = await bulk.run(approvable, (item) =>
      api(`/projects/${item.projectId}/approve`, {
        method: 'POST',
        body: {},
        idempotencyKey: newIdempotencyKey(),
      }),
    );
    (result.failed.length ? toast.error : toast.success)(summary(result));
    await onChange();
  };

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
          className="flex items-start gap-2 rounded-panel border border-destructive/30 bg-destructive-soft p-3 text-sm"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {t('heldNote', { count: plan.counts.HELD })}
        </p>
      )}
      {open && (
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>{t('reviewWindow')}</p>
          {/* 23.6 rolling generation; each waiting post says when (CreatesAtText). */}
          <p>{t('rolling')}</p>
        </div>
      )}
      {waiting > 0 && (
        <p className="text-xs text-muted-foreground">{t('createsLater', { count: waiting })}</p>
      )}

      {(approvable.length > 0 || bulk.running) && (
        <PlanBulkBar label={tb('label')} selectable={0} selected={0} progress={bulk.progress}>
          <Button size="sm" disabled={bulk.running} onClick={() => void approveAll()}>
            <Check /> {tb('approveAll', { count: approvable.length })}
          </Button>
        </PlanBulkBar>
      )}

      <PlanTimeline
        items={plan.items}
        timezone={plan.timezone}
        startDate={plan.startDate}
        label={t('daysAria')}
        renderItem={(item) => (
          <PlanItemRow
            key={item.id}
            plan={plan}
            item={item}
            now={now}
            changeable={open && canChangeScheduled(item, now)}
            mayApprove={mayApprove}
            locked={bulk.running}
            call={call}
          />
        )}
      />

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
