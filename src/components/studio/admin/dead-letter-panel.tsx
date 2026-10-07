'use client';

import { useState } from 'react';
import { Inbox, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { ReasonDialog } from './reason-dialog';
import { RequeueDialog } from './requeue-dialog';

// BACKLOG 15.D4 / spec 11.5 — dead-letter view: failed jobs per queue with retry / inspect /
// drain / requeue-with-different-provider. GET /admin/queues/:name/failed (secrets redacted by the
// server), POST …/:jobId/retry, POST …/:jobId/requeue { providerId? }, POST …/drain { confirm }.
// Draining is never automatic: the operator types the queue name.

/** Mirror of QUEUES in src/lib/studio/queue/queues.ts. */
export const STUDIO_QUEUES = [
  'studio-orchestration',
  'studio-assets',
  'studio-publish',
  'studio-scheduled',
  'studio-analytics',
  'studio-library',
] as const;

export interface DeadLetterJob {
  id: string;
  name: string;
  data: unknown;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  organisationId: string | null;
  projectId: string | null;
  addedAt: string;
  processedAt: string | null;
  failedAt: string | null;
  providerOverride: boolean;
}

export interface FailedPage {
  ok: true;
  queue: string;
  total: number;
  jobs: DeadLetterJob[];
  nextCursor: string | null;
}

type RequeueOutcome =
  | { action: 'requeued'; providerId?: string }
  | { action: 'resumed_project'; projectId: string; runId: string; jobs: number };

const PAGE_SIZE = 25;
const enc = encodeURIComponent;

type DeadLettersT = ReturnType<typeof useTranslations<'admin.deadLetters'>>;

export function outcomeText(outcome: RequeueOutcome, t: DeadLettersT): string {
  return outcome.action === 'resumed_project'
    ? t('resumedToast', { projectId: outcome.projectId, jobs: outcome.jobs })
    : t('requeuedToast');
}

function JobRow({
  job,
  onRetry,
  onRequeue,
}: {
  job: DeadLetterJob;
  onRetry: (job: DeadLetterJob) => void;
  onRequeue: (job: DeadLetterJob) => void;
}) {
  const t = useTranslations('admin.deadLetters');
  const f = useFormat();
  const meta = [
    job.organisationId ? t('organisation', { id: job.organisationId }) : t('platformJob'),
    job.projectId ? t('project', { id: job.projectId }) : null,
    t('attempts', { count: job.attemptsMade }),
    job.failedAt ? t('failedWhen', { when: f.relative(job.failedAt) }) : null,
  ].filter((part): part is string => part !== null);
  return (
    <li className="grid gap-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {job.name}
            <span className="ms-2 font-mono text-xs font-normal text-muted-foreground">
              {job.id}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{meta.join(' · ')}</p>
          <p className="mt-1 text-sm break-words text-destructive">{job.failedReason}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => onRetry(job)}>
            {t('retry')}
            <span className="sr-only"> {job.id}</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => onRequeue(job)}>
            {t('requeue')}
            <span className="sr-only"> {job.id}</span>
          </Button>
        </div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t('inspect')}</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2">
          {JSON.stringify(job.data, null, 2)}
        </pre>
        {job.stacktrace.length > 0 && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap">
            {job.stacktrace.join('\n')}
          </pre>
        )}
      </details>
    </li>
  );
}

export function DeadLetterPanel() {
  const t = useTranslations('admin.deadLetters');
  const errorMessage = useErrorMessage();
  const [queue, setQueue] = useState<string>('studio-assets');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const res = useApi<FailedPage>(`/admin/queues/${enc(queue)}/failed`, {
    limit: PAGE_SIZE,
    cursor,
  });
  const [retrying, setRetrying] = useState<DeadLetterJob | null>(null);
  const [requeueing, setRequeueing] = useState<DeadLetterJob | null>(null);
  const [draining, setDraining] = useState(false);

  const act = async (work: () => Promise<string>): Promise<boolean> => {
    try {
      toast.success(await work());
      await res.mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };
  const base = `/admin/queues/${enc(queue)}/failed`;

  const retry = (reason: string) =>
    act(async () => {
      if (!retrying) return '';
      const out = await api<{ advisory: string | null }>(`${base}/${enc(retrying.id)}/retry`, {
        method: 'POST',
        body: { reason },
        idempotencyKey: newIdempotencyKey(),
      });
      return out.advisory
        ? t('retriedAdvisoryToast', { advisory: out.advisory })
        : t('retriedToast');
    });
  const requeue = (body: { providerId?: string; reason: string }) =>
    act(async () => {
      if (!requeueing) return '';
      const out = await api<{ outcome: RequeueOutcome }>(`${base}/${enc(requeueing.id)}/requeue`, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      });
      return outcomeText(out.outcome, t);
    });
  const drain = (reason: string) =>
    act(async () => {
      const out = await api<{ removed: number }>(`${base}/drain`, {
        method: 'POST',
        body: { confirm: queue, reason },
        idempotencyKey: newIdempotencyKey(),
      });
      setCursors([]);
      return t('drainedToast', { count: out.removed, queue });
    });

  const page = res.data;
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('queueAria')}
            className={selectClass}
            value={queue}
            onChange={(e) => {
              setQueue(e.target.value);
              setCursors([]);
            }}
          >
            {STUDIO_QUEUES.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void res.mutate()}>
            <RotateCw /> {t('refresh')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!page || page.total === 0}
            onClick={() => setDraining(true)}
          >
            {t('drain')}
          </Button>
        </div>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !page ? (
        <Skeleton aria-label={t('loadingAria')} className="h-40" />
      ) : page.jobs.length === 0 ? (
        <EmptyState
          media={<Inbox className="size-8" strokeWidth={1.5} />}
          title={t('emptyTitle')}
          description={t('emptyBody', { queue })}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t('total', { count: page.total, queue: page.queue })}
          </p>
          <ul aria-label={t('listAria')} className="divide-y divide-border/70">
            {page.jobs.map((job) => (
              <JobRow key={job.id} job={job} onRetry={setRetrying} onRequeue={setRequeueing} />
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={cursors.length === 0}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              {t('newer')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!page.nextCursor}
              onClick={() => page.nextCursor && setCursors((c) => [...c, page.nextCursor ?? ''])}
            >
              {t('older')}
            </Button>
          </div>
        </>
      )}
      <ReasonDialog
        open={retrying !== null}
        onOpenChange={(open) => !open && setRetrying(null)}
        title={t('retryTitle', { name: retrying?.name ?? '' })}
        description={t('retryBody')}
        confirmLabel={t('retryConfirm')}
        onConfirm={retry}
      />
      <RequeueDialog
        job={requeueing}
        onOpenChange={(open) => !open && setRequeueing(null)}
        onConfirm={requeue}
      />
      <ReasonDialog
        open={draining}
        onOpenChange={setDraining}
        title={t('drainTitle', { queue })}
        description={t('drainBody')}
        confirmLabel={t('drainConfirm')}
        confirmPhrase={queue}
        destructive
        onConfirm={drain}
      />
    </Section>
  );
}
