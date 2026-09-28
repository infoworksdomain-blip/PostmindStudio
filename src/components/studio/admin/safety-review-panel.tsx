'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { ReasonDialog } from './reason-dialog';

// BACKLOG 13.17 / spec 16.4 — content-safety review queue. A script-safety REVIEW verdict or a
// review-level content-safety flag pauses the run here; Allow resumes it, Block fails the
// project with the note (both need a note, recorded in the audit log and shown to the customer
// on Block). GET /admin/safety-reviews, POST /admin/safety-reviews/:id/decision.

type ReviewState = 'PENDING' | 'ALLOWED' | 'BLOCKED';

export interface SafetyReviewItem {
  id: string;
  organisationId: string;
  projectId: string;
  projectName: string | null;
  projectState: string | null;
  kind: 'script' | 'content';
  state: ReviewState;
  reason: string;
  previewUrl: string | null;
  scripts: Array<{ platform: string; excerpt: string }>;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface ListResponse {
  data: SafetyReviewItem[];
  pendingCount: number;
  hasMore: boolean;
}

function ReviewCard({
  item,
  onDecide,
}: {
  item: SafetyReviewItem;
  onDecide: (item: SafetyReviewItem, decision: 'ALLOW' | 'BLOCK') => void;
}) {
  const t = useTranslations('admin.safety.review');
  const ts = useTranslations('admin.safety');
  const f = useFormat();
  const stateLabel = t(`state.${item.state}`);
  return (
    <li className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[minmax(0,240px)_1fr]">
      <div>
        {item.kind === 'content' && item.previewUrl ? (
          <video
            src={item.previewUrl}
            controls
            muted
            preload="metadata"
            aria-label={
              item.projectName
                ? t('previewAria', { name: item.projectName })
                : t('previewAriaUnnamed')
            }
            className="aspect-[9/16] max-h-72 w-full rounded-md bg-black object-contain"
          />
        ) : (
          <div className="grid gap-2 text-xs">
            {item.scripts.length === 0 && <p className="text-muted-foreground">{t('noScript')}</p>}
            {item.scripts.map((s) => (
              <blockquote
                key={s.platform}
                className="max-h-40 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap"
              >
                <span className="font-medium">
                  {t('scriptLabel', { platform: f.platform(s.platform) })}
                </span>{' '}
                {s.excerpt}
              </blockquote>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">
          {item.projectName ?? item.projectId}
          <span className="ms-2 text-xs font-normal text-muted-foreground">
            {t('kindWhen', {
              kind: item.kind === 'script' ? t('kindScript') : t('kindContent'),
              when: f.relative(item.createdAt),
            })}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {t('ids', { organisationId: item.organisationId, projectId: item.projectId })}
        </p>
        <p>
          <span className="text-muted-foreground">{t('flagged')}</span> {item.reason}
        </p>
        {item.state === 'PENDING' ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={() => onDecide(item, 'ALLOW')}>
              {t('allowResume')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onDecide(item, 'BLOCK')}>
              {t('block')}
            </Button>
          </div>
        ) : (
          <p className="text-xs">
            {item.decidedAt
              ? ts('decidedWhen', { state: stateLabel, when: f.relative(item.decidedAt) })
              : stateLabel}
            {item.decisionNote && <> — {ts('quotedNote', { note: item.decisionNote })}</>}
          </p>
        )}
      </div>
    </li>
  );
}

export function SafetyReviewPanel() {
  const t = useTranslations('admin.safety.review');
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<ReviewState>('PENDING');
  const res = useApi<ListResponse>('/admin/safety-reviews', { state }, { refreshInterval: 30_000 });
  const [deciding, setDeciding] = useState<{
    item: SafetyReviewItem;
    decision: 'ALLOW' | 'BLOCK';
  } | null>(null);
  const blocking = deciding?.decision === 'BLOCK';

  const decide = async (note: string): Promise<boolean> => {
    if (!deciding) return false;
    try {
      await api(`/admin/safety-reviews/${deciding.item.id}/decision`, {
        method: 'POST',
        body: { decision: deciding.decision, note },
      });
      toast.success(deciding.decision === 'ALLOW' ? t('allowedToast') : t('blockedToast'));
      await res.mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <select
          aria-label={t('showAria')}
          className={selectClass}
          value={state}
          onChange={(e) => setState(e.target.value as ReviewState)}
        >
          <option value="PENDING">
            {res.data
              ? t('filterWaitingCount', { count: res.data.pendingCount })
              : t('filterWaiting')}
          </option>
          <option value="ALLOWED">{t('filterAllowed')}</option>
          <option value="BLOCKED">{t('filterBlocked')}</option>
        </select>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label={t('loadingAria')} className="h-40" />
      ) : res.data.data.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-8" strokeWidth={1.5} />}
          title={state === 'PENDING' ? t('emptyPendingTitle') : t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        <ul aria-label={t('listAria')} className="grid gap-3">
          {res.data.data.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              onDecide={(i, decision) => setDeciding({ item: i, decision })}
            />
          ))}
        </ul>
      )}
      <ReasonDialog
        open={deciding !== null}
        onOpenChange={(open) => !open && setDeciding(null)}
        title={blocking ? t('blockTitle') : t('allowTitle')}
        description={blocking ? t('blockBody') : t('allowBody')}
        confirmLabel={blocking ? t('blockConfirm') : t('allowConfirm')}
        destructive={blocking}
        onConfirm={decide}
      />
    </Section>
  );
}
