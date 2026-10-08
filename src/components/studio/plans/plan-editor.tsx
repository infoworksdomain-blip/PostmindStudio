'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RefreshCw, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { planKindQuarters, quartersToVideos } from '@/lib/studio/billing/allowance-units';
import { useShowCosts } from '../account/use-show-costs';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { BusinessHashtagsNote } from '../hashtags/business-hashtags-panel';
import { useBulkRun } from './bulk-run';
import { PlanBulkBar, useBulkSummary } from './plan-bulk-bar';
import { AddPost, DraftItemRow, type Call } from './plan-draft-item';
import { CappedNotice } from './plan-parts';
import { kindCounts, moveItem, type Plan } from './plan-model';
import { PlanTimeline } from './plan-timeline';

// 20.9 — the DRAFT editor: every planned post on the plan's week-by-week timeline (25.9), each
// editable, movable, replaceable and deletable (plan-draft-item.tsx); posts can be added at a free
// time. The estimate (posts, allowance; the cost only for platform staff, operator decision
// 2026-10-04) sits above "Generate and schedule", which asks once before everything is made.
// 25.9: select posts for a bulk "New topics" or "Delete" — the per-item routes, one at a time.

type Change = () => Promise<void>;

export function PlanEditor({ plan, onChange }: { plan: Plan; onChange: Change }) {
  const t = useTranslations('plans.editor');
  const tb = useTranslations('plans.bulk');
  const f = useFormat();
  const showCosts = useShowCosts();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const summary = useBulkSummary();
  const [confirm, confirmDialog] = useConfirm();
  const bulk = useBulkRun();
  const [confirming, setConfirming] = useState<'generate' | 'discard' | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const items = plan.items.filter((i) => i.status === 'PLANNED');
  const ids = items.map((i) => i.id);
  const counts = kindCounts(items);
  const base = `/content-plans/${plan.id}`;
  // 20.12: a plan with no connected account makes its posts and saves them for review.
  const noAccounts = plan.targets !== undefined && plan.targets.length === 0;
  // Only posts still on the plan (and written) stay selected after a refresh.
  const selectable = useMemo(() => items.filter((i) => i.title).map((i) => i.id), [items]);
  const selected = selectable.filter((id) => picked.has(id));

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

  const move = (id: string, delta: -1 | 1) =>
    call(`${base}/reorder`, 'POST', { itemIds: moveItem(ids, id, delta) });

  const bulkRun = async (path: (id: string) => string, method: 'POST' | 'DELETE') => {
    const result = await bulk.run(selected, (id) =>
      api(path(id), { method, idempotencyKey: newIdempotencyKey() }),
    );
    (result.failed.length ? toast.error : toast.success)(summary(result));
    setPicked(new Set(result.failed.map((r) => r.item)));
    await onChange();
  };
  const bulkDelete = async () => {
    const ok = await confirm({
      title: tb('deleteConfirmTitle', { count: selected.length }),
      description: tb('deleteConfirmBody'),
      confirmLabel: tb('delete', { count: selected.length }),
    });
    if (ok) await bulkRun((id) => `${base}/items/${id}`, 'DELETE');
  };

  return (
    <div className="flex flex-col gap-6">
      <CappedNotice plan={plan} />
      {plan.draftError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-destructive/30 bg-destructive-soft p-3 text-sm"
        >
          <span>{t('draftError')}</span>
          <Button size="sm" variant="outline" onClick={() => void call(`${base}/redraft`, 'POST')}>
            <RefreshCw /> {t('redraft')}
          </Button>
        </div>
      )}
      <section
        aria-labelledby="plan-estimate"
        className="flex flex-col gap-3 rounded-panel border border-border bg-card p-5 shadow-raised"
      >
        <h2 id="plan-estimate" className="text-lg font-semibold tracking-tight">
          {t('summary', {
            count: items.length,
            videos: counts.VIDEO,
            slideshows: counts.SLIDESHOW,
          })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {showCosts && (
            <>
              {t('costEstimate', {
                typical: f.pence(plan.estimate.typicalPence),
                max: f.pence(plan.estimate.maxPence),
              })}{' '}
            </>
          )}
          {t('allowanceUse', {
            count: quartersToVideos(items.reduce((n, i) => n + planKindQuarters(i.kind), 0)),
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {noAccounts ? t('noAccountsWindow') : t('reviewWindow')}
        </p>
        <BusinessHashtagsNote businessId={plan.businessId} />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setConfirming('generate')}
            disabled={items.length === 0 || items.some((i) => !i.title) || bulk.running}
          >
            <Send className="rtl:-scale-x-100" /> {t('generate')}
          </Button>
          <Button variant="outline" onClick={() => setConfirming('discard')}>
            {t('discard')}
          </Button>
        </div>
      </section>

      <PlanBulkBar
        label={tb('label')}
        selectable={selectable.length}
        selected={selected.length}
        onToggleAll={(all) => setPicked(new Set(all ? selectable : []))}
        progress={bulk.progress}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={selected.length === 0 || bulk.running}
          onClick={() => void bulkRun((id) => `${base}/items/${id}/regenerate`, 'POST')}
        >
          <RefreshCw /> {tb('regenerate', { count: selected.length })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={selected.length === 0 || bulk.running}
          onClick={() => void bulkDelete()}
        >
          <Trash2 /> {tb('delete', { count: selected.length })}
        </Button>
      </PlanBulkBar>

      <PlanTimeline
        items={items}
        timezone={plan.timezone}
        startDate={plan.startDate}
        label={t('daysAria')}
        renderItem={(item) => (
          <DraftItemRow
            key={item.id}
            plan={plan}
            item={item}
            first={ids[0] === item.id}
            last={ids[ids.length - 1] === item.id}
            selected={picked.has(item.id)}
            onSelect={(on) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (on) next.add(item.id);
                else next.delete(item.id);
                return next;
              })
            }
            onMove={(delta) => void move(item.id, delta)}
            call={call}
            locked={bulk.running}
          />
        )}
      />

      <AddPost plan={plan} call={call} />

      {confirmDialog}
      <ConfirmDialog
        open={confirming === 'generate'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('generateConfirmTitle', { count: items.length })}
        description={noAccounts ? t('generateConfirmBodyNoAccounts') : t('generateConfirmBody')}
        confirmLabel={t('generate')}
        cancelLabel={t('notYet')}
        destructive={false}
        onConfirm={() => call(`${base}/generate`, 'POST', undefined, t('generating'))}
      />
      <ConfirmDialog
        open={confirming === 'discard'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('discardConfirmTitle')}
        description={t('discardConfirmBody')}
        confirmLabel={t('discard')}
        cancelLabel={t('notYet')}
        onConfirm={async () => {
          const done = await call(`${base}/cancel`, 'POST', undefined, t('discarded'));
          if (done) router.push('/plans');
          return done;
        }}
      />
    </div>
  );
}
