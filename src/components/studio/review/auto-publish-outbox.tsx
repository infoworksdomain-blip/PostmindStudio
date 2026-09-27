'use client';

import { useState } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { formatDate, PLATFORM_LABEL } from '@/lib/client/format';

// BACKLOG 13.21 — the auto-publish outbox of the latest approval (GET /projects/:id/auto-publish):
// per target pending / sending / sent / failed, with attempts and the next retry, and a Retry
// button for targets that gave up (POST /projects/:id/auto-publish/retry).

export interface OutboxRow {
  id: string;
  targetIndex: number;
  target: { platform: string; account: string | null; scheduleOffsetMinutes: number | null };
  state: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  publicationId: string | null;
}

export interface OutboxResponse {
  outbox: OutboxRow[];
}

function stateText(row: OutboxRow): string {
  switch (row.state) {
    case 'SENT':
      return 'Sent to publish';
    case 'SENDING':
      return 'Sending…';
    case 'PENDING':
      return row.attempts === 0
        ? 'Pending'
        : `Retrying${row.nextAttemptAt ? ` at ${formatDate(row.nextAttemptAt)}` : ''} (attempt ${row.attempts + 1} of ${row.maxAttempts})`;
    case 'FAILED':
      return `Failed after ${row.attempts} attempt${row.attempts === 1 ? '' : 's'}`;
  }
}

export function AutoPublishOutbox({ projectId }: { projectId: string }) {
  const path = `/projects/${encodeURIComponent(projectId)}/auto-publish`;
  const res = useApi<OutboxResponse>(path, undefined, { refreshInterval: 30_000 });
  const [pending, setPending] = useState(false);
  const rows = res.data?.outbox ?? [];
  if (rows.length === 0) return null;
  const failed = rows.filter((r) => r.state === 'FAILED').length;

  const retry = async () => {
    setPending(true);
    try {
      const out = await api<{ requeued: number }>(`${path}/retry`, { method: 'POST', body: {} });
      toast.success(`Retrying ${out.requeued} target${out.requeued === 1 ? '' : 's'}`);
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-2" aria-label="Auto-publish status">
      <p className="text-xs font-medium text-muted-foreground">Auto-publish status</p>
      <ul className="grid gap-1 text-sm">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5"
          >
            <span>{PLATFORM_LABEL[row.target.platform] ?? row.target.platform}</span>
            <span className={row.state === 'FAILED' ? 'text-destructive' : undefined}>
              {stateText(row)}
              {row.state !== 'SENT' && row.lastError && ` — ${row.lastError}`}
            </span>
          </li>
        ))}
      </ul>
      {failed > 0 && (
        <div>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void retry()}>
            {pending ? <Loader2 className="animate-spin" /> : <RotateCw />}
            Retry auto-publish
          </Button>
        </div>
      )}
    </div>
  );
}
