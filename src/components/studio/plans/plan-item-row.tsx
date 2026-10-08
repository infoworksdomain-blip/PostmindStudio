'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ExternalLink, Hash, Repeat2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { useLiveStatus } from '../live/live-projects-context';
import { StatusChip } from '../live/status-chip';
import { ItemCopyEditor } from './item-copy';
import { ItemForm } from './item-form';
import type { Call } from './plan-draft-item';
import { CreatesAtText, ItemMeta, ItemStatusBadge, ReasonText } from './plan-parts';
import type { Plan, PlanItem } from './plan-model';

// 20.9 — one post of a generating / scheduled plan: time, format, topic, status (24.2: the live
// stage and ETA while it is made), why it is held or skipped, when it will be created (23.6) and,
// before its time, caption and hashtags, "Swap topic" and "Remove". 25.9: a post waiting for
// review is approved here with the review screen's route (POST /projects/:id/approve).

/** 24.2: the post's live stage and ETA while its project is being made (SSE). */
function LiveChip({ projectId }: { projectId: string }) {
  const live = useLiveStatus(projectId);
  return live ? <StatusChip live={live} /> : null;
}

export function PlanItemRow({
  plan,
  item,
  now,
  changeable,
  mayApprove,
  locked,
  call,
}: {
  plan: Plan;
  item: PlanItem;
  now: number;
  changeable: boolean;
  mayApprove: boolean;
  locked: boolean;
  call: Call;
}) {
  const t = useTranslations('plans.view');
  const th = useTranslations('hashtags.plan');
  const [swapping, setSwapping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const path = `/content-plans/${plan.id}/items/${item.id}`;
  const faded = item.status === 'REMOVED' || item.status === 'SKIPPED';
  const canApprove = mayApprove && item.status === 'READY' && item.projectId !== null;
  const approve = async () => {
    setApproving(true);
    await call(`/projects/${item.projectId}/approve`, 'POST', {}, t('approved'));
    setApproving(false);
  };
  return (
    <li
      data-plan-item={item.id}
      className={cn(
        'rounded-panel border bg-card p-4',
        faded ? 'border-dashed border-border opacity-70' : 'border-border',
        item.status === 'READY' && 'border-warning/50',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <ItemMeta item={item} timezone={plan.timezone} />
          <p className="mt-1.5 font-medium">{item.title}</p>
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
        <div className="mt-3 flex flex-wrap gap-1">
          {canApprove && (
            <Button
              size="sm"
              loading={approving}
              disabled={locked}
              aria-label={t('approveAria', { title: item.title })}
              onClick={() => void approve()}
            >
              {!approving && <Check />} {t('approve')}
            </Button>
          )}
          {item.projectId && (
            <Button asChild size="sm" variant="ghost">
              <Link
                href={`/projects/${item.projectId}`}
                aria-label={t('openAria', { title: item.title })}
              >
                <ExternalLink className="rtl:-scale-x-100" /> {t('open')}
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
                disabled={locked}
                aria-label={t('swapAria', { title: item.title })}
                onClick={() => setSwapping(true)}
              >
                <Repeat2 /> {t('swap')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
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
