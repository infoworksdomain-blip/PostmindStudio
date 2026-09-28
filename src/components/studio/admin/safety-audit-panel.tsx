'use client';

import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { formatDate, relativeTime, safeHttpUrl } from '@/lib/client/format';
import { EmptyState, ErrorState, Section, Stat } from '../primitives';
import { selectClass } from '../library/library-filters';
import { ReasonDialog } from './reason-dialog';

// BACKLOG 14.11 — Admin → Safety audit: the Trust & Safety monthly audit (runbooks/
// content-safety-miss.md). A job samples N videos published last month; staff re-check each one
// and record Pass or Miss (a miss needs a note, notifies staff and counts towards the "Hive scan
// miss rate"). GET /admin/safety-audit, POST /admin/safety-audit/:id/result, POST …/sample.

type Result = 'pending' | 'pass' | 'miss';

export interface AuditItem {
  id: string;
  period: string;
  organisationId: string;
  publicationId: string;
  projectId: string;
  platform: string;
  platformUrl: string | null;
  publishedAt: string;
  result: Result;
  note: string | null;
  reviewedAt: string | null;
  previewUrl: string | null;
}

export interface AuditResponse {
  summary: {
    period: string;
    sampled: number;
    pending: number;
    passed: number;
    missed: number;
    missRate: number | null;
  };
  periods: string[];
  data: AuditItem[];
  hasMore: boolean;
}

const RESULT_LABEL: Record<Result, string> = {
  pending: 'Waiting for review',
  pass: 'Pass',
  miss: 'Miss',
};

function AuditCard({
  item,
  onPass,
  onMiss,
  busy,
}: {
  item: AuditItem;
  onPass: () => void;
  onMiss: () => void;
  busy: boolean;
}) {
  const link = safeHttpUrl(item.platformUrl);
  return (
    <li className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[minmax(0,200px)_1fr]">
      {item.previewUrl ? (
        <video
          src={item.previewUrl}
          controls
          muted
          preload="metadata"
          aria-label={`Published ${item.platform} video`}
          className="aspect-[9/16] max-h-64 w-full rounded-md bg-black object-contain"
        />
      ) : (
        <div className="grid aspect-[9/16] max-h-64 place-items-center rounded-md bg-muted text-xs text-muted-foreground">
          No preview
        </div>
      )}
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">
          {item.platform}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            published {formatDate(item.publishedAt)}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Organisation {item.organisationId} · project {item.projectId}
        </p>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Open the post <ExternalLink className="size-3" />
          </a>
        )}
        {item.result === 'pending' ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={onPass} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Pass
            </Button>
            <Button size="sm" variant="destructive" onClick={onMiss} disabled={busy}>
              Miss
            </Button>
          </div>
        ) : (
          <p className={item.result === 'miss' ? 'text-xs text-destructive' : 'text-xs'}>
            {RESULT_LABEL[item.result]}
            {item.reviewedAt && ` ${relativeTime(item.reviewedAt)}`}
            {item.note && ` — “${item.note}”`}
          </p>
        )}
      </div>
    </li>
  );
}

export function SafetyAuditPanel() {
  const [period, setPeriod] = useState('');
  const [result, setResult] = useState<Result | ''>('pending');
  const res = useApi<AuditResponse>('/admin/safety-audit', { period, result, limit: 50 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [missing, setMissing] = useState<AuditItem | null>(null);
  const [sampling, setSampling] = useState(false);
  const shown = res.data?.summary.period ?? period;

  const record = async (item: AuditItem, verdict: 'pass' | 'miss', note?: string) => {
    setBusyId(item.id);
    try {
      await api(`/admin/safety-audit/${item.id}/result`, {
        method: 'POST',
        body: { result: verdict, ...(note && { note }) },
      });
      toast.success(verdict === 'pass' ? 'Recorded as pass' : 'Miss recorded — staff notified');
      await res.mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const drawSample = async () => {
    setSampling(true);
    try {
      const out = await api<{ sample: { added: number; total: number; population: number } }>(
        '/admin/safety-audit/sample',
        { method: 'POST', body: shown ? { period: shown } : {} },
      );
      toast.success(
        `${out.sample.added} added — ${out.sample.total} of ${out.sample.population} published videos sampled`,
      );
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSampling(false);
    }
  };

  const periods = [...new Set([shown, ...(res.data?.periods ?? [])].filter(Boolean))];

  return (
    <Section
      title="Trust & Safety monthly audit"
      description="A random sample of last month’s published videos, re-checked by a person. A miss is a video the Hive scan should have blocked or sent to review."
      actions={
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Audit month"
            className={selectClass}
            value={shown}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            aria-label="Result"
            className={selectClass}
            value={result}
            onChange={(e) => setResult(e.target.value as Result | '')}
          >
            <option value="pending">Waiting for review</option>
            <option value="miss">Misses</option>
            <option value="pass">Passes</option>
            <option value="">All</option>
          </select>
          <Button size="sm" variant="outline" onClick={() => void drawSample()} disabled={sampling}>
            {sampling && <Loader2 className="animate-spin" />}
            Draw sample
          </Button>
        </div>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label="Loading safety audit" className="h-64" />
      ) : (
        <div className="grid gap-6">
          <div className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat label="Sampled" value={res.data.summary.sampled} />
            <Stat label="Waiting" value={res.data.summary.pending} />
            <Stat label="Passed" value={res.data.summary.passed} />
            <Stat label="Missed" value={res.data.summary.missed} />
            <Stat
              label="Hive scan miss rate"
              value={
                res.data.summary.missRate === null
                  ? '—'
                  : `${(res.data.summary.missRate * 100).toFixed(1)}%`
              }
              hint="missed ÷ reviewed"
            />
          </div>
          {res.data.data.length === 0 ? (
            <EmptyState
              title={res.data.summary.sampled === 0 ? 'No sample for this month' : 'Nothing here'}
              description={
                res.data.summary.sampled === 0
                  ? 'The sample is drawn on the 1st at 06:00 UTC. Draw it now if the job did not run.'
                  : 'No videos match this filter.'
              }
            />
          ) : (
            <ul className="grid gap-3">
              {res.data.data.map((item) => (
                <AuditCard
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onPass={() => void record(item, 'pass')}
                  onMiss={() => setMissing(item)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      <ReasonDialog
        open={missing !== null}
        onOpenChange={(open) => !open && setMissing(null)}
        title="Record a miss"
        description="Say what the scan missed. Staff are notified, and the publication should be taken down (runbooks/content-safety-miss.md)."
        confirmLabel="Record miss"
        destructive
        onConfirm={async (note) => (missing ? record(missing, 'miss', note) : false)}
      />
    </Section>
  );
}
