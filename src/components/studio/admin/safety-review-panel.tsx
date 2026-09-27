'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { relativeTime } from '@/lib/client/format';
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

const STATE_LABEL: Record<ReviewState, string> = {
  PENDING: 'Waiting for a decision',
  ALLOWED: 'Allowed',
  BLOCKED: 'Blocked',
};

function ReviewCard({
  item,
  onDecide,
}: {
  item: SafetyReviewItem;
  onDecide: (item: SafetyReviewItem, decision: 'ALLOW' | 'BLOCK') => void;
}) {
  return (
    <li className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[minmax(0,240px)_1fr]">
      <div>
        {item.kind === 'content' && item.previewUrl ? (
          <video
            src={item.previewUrl}
            controls
            muted
            preload="metadata"
            aria-label={`Preview of ${item.projectName ?? 'the flagged video'}`}
            className="aspect-[9/16] max-h-72 w-full rounded-md bg-black object-contain"
          />
        ) : (
          <div className="grid gap-2 text-xs">
            {item.scripts.length === 0 && (
              <p className="text-muted-foreground">No script stored for this run.</p>
            )}
            {item.scripts.map((s) => (
              <blockquote
                key={s.platform}
                className="max-h-40 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap"
              >
                <span className="font-medium">{s.platform}: </span>
                {s.excerpt}
              </blockquote>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">
          {item.projectName ?? item.projectId}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {item.kind === 'script' ? 'Script (before generation)' : 'Rendered video'} ·{' '}
            {relativeTime(item.createdAt)}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Organisation {item.organisationId} · project {item.projectId}
        </p>
        <p>
          <span className="text-muted-foreground">Flagged: </span>
          {item.reason}
        </p>
        {item.state === 'PENDING' ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={() => onDecide(item, 'ALLOW')}>
              Allow and resume
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onDecide(item, 'BLOCK')}>
              Block
            </Button>
          </div>
        ) : (
          <p className="text-xs">
            {STATE_LABEL[item.state]}
            {item.decidedAt && ` ${relativeTime(item.decidedAt)}`}
            {item.decisionNote && ` — “${item.decisionNote}”`}
          </p>
        )}
      </div>
    </li>
  );
}

export function SafetyReviewPanel() {
  const [state, setState] = useState<ReviewState>('PENDING');
  const res = useApi<ListResponse>('/admin/safety-reviews', { state }, { refreshInterval: 30_000 });
  const [deciding, setDeciding] = useState<{
    item: SafetyReviewItem;
    decision: 'ALLOW' | 'BLOCK';
  } | null>(null);

  const decide = async (note: string): Promise<boolean> => {
    if (!deciding) return false;
    try {
      await api(`/admin/safety-reviews/${deciding.item.id}/decision`, {
        method: 'POST',
        body: { decision: deciding.decision, note },
      });
      toast.success(deciding.decision === 'ALLOW' ? 'Allowed — the run resumes' : 'Blocked');
      await res.mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <Section
      title="Content-safety review"
      description="Runs paused by a script-safety REVIEW verdict or a review-level Hive flag (spec 13.2 / 16.4). Block-level results never reach this queue."
      actions={
        <select
          aria-label="Show reviews"
          className={selectClass}
          value={state}
          onChange={(e) => setState(e.target.value as ReviewState)}
        >
          <option value="PENDING">Waiting{res.data ? ` (${res.data.pendingCount})` : ''}</option>
          <option value="ALLOWED">Allowed</option>
          <option value="BLOCKED">Blocked</option>
        </select>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label="Loading reviews" className="h-40" />
      ) : res.data.data.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-8" strokeWidth={1.5} />}
          title={state === 'PENDING' ? 'Nothing waiting' : 'No reviews yet'}
          description="Paused runs appear here with the flag, a preview and the script."
        />
      ) : (
        <ul aria-label="Safety reviews" className="grid gap-3">
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
        title={deciding?.decision === 'BLOCK' ? 'Block this video' : 'Allow and resume'}
        description={
          deciding?.decision === 'BLOCK'
            ? 'The project fails with your note; the customer sees it.'
            : 'The paused run continues from where it stopped.'
        }
        confirmLabel={deciding?.decision === 'BLOCK' ? 'Block' : 'Allow'}
        destructive={deciding?.decision === 'BLOCK'}
        onConfirm={decide}
      />
    </Section>
  );
}
