'use client';

import { useState } from 'react';
import { Inbox, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { relativeTime } from '@/lib/client/format';
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

export function outcomeText(outcome: RequeueOutcome): string {
  return outcome.action === 'resumed_project'
    ? `Requeued: project ${outcome.projectId} resumed its asset stage (${outcome.jobs} job${outcome.jobs === 1 ? '' : 's'})`
    : 'Requeued';
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
  return (
    <li className="grid gap-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {job.name}
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {job.id}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {job.organisationId ? `Organisation ${job.organisationId}` : 'Platform job'}
            {job.projectId && ` · project ${job.projectId}`} · {job.attemptsMade} attempt
            {job.attemptsMade === 1 ? '' : 's'}
            {job.failedAt && ` · failed ${relativeTime(job.failedAt)}`}
          </p>
          <p className="mt-1 text-sm break-words text-destructive">{job.failedReason}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => onRetry(job)}>
            Retry<span className="sr-only"> {job.id}</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => onRequeue(job)}>
            Requeue<span className="sr-only"> {job.id}</span>
          </Button>
        </div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Inspect job data</summary>
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
      return out.advisory ? `Retried. ${out.advisory}` : 'Retried: the job is waiting again';
    });
  const requeue = (body: { providerId?: string; reason: string }) =>
    act(async () => {
      if (!requeueing) return '';
      const out = await api<{ outcome: RequeueOutcome }>(`${base}/${enc(requeueing.id)}/requeue`, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      });
      return outcomeText(out.outcome);
    });
  const drain = (reason: string) =>
    act(async () => {
      const out = await api<{ removed: number }>(`${base}/drain`, {
        method: 'POST',
        body: { confirm: queue, reason },
        idempotencyKey: newIdempotencyKey(),
      });
      setCursors([]);
      return `Drained ${out.removed} failed job${out.removed === 1 ? '' : 's'} from ${queue}`;
    });

  const page = res.data;
  return (
    <Section
      title="Dead letters"
      description="Jobs that exhausted their retries (spec 11.5). Nothing here is drained automatically. Job data is shown with secrets and URL tokens removed."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Queue"
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
            <RotateCw /> Refresh
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!page || page.total === 0}
            onClick={() => setDraining(true)}
          >
            Drain queue
          </Button>
        </div>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !page ? (
        <Skeleton aria-label="Loading failed jobs" className="h-40" />
      ) : page.jobs.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-8" strokeWidth={1.5} />}
          title="No failed jobs"
          description={`Nothing is dead-lettered in ${queue}.`}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {page.total.toLocaleString('en-GB')} failed in {page.queue}, newest first.
          </p>
          <ul aria-label="Failed jobs" className="divide-y divide-border/70">
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
              Newer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!page.nextCursor}
              onClick={() => page.nextCursor && setCursors((c) => [...c, page.nextCursor ?? ''])}
            >
              Older
            </Button>
          </div>
        </>
      )}
      <ReasonDialog
        open={retrying !== null}
        onOpenChange={(open) => !open && setRetrying(null)}
        title={`Retry ${retrying?.name ?? ''}?`}
        description="The same job runs again with its attempts reset. This can spend provider money on the organisation’s behalf."
        confirmLabel="Retry"
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
        title={`Drain every failed job in ${queue}?`}
        description="The failed jobs are deleted without running. This cannot be undone."
        confirmLabel="Drain"
        confirmPhrase={queue}
        destructive
        onConfirm={drain}
      />
    </Section>
  );
}
