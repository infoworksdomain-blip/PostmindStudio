'use client';

import { useState } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat, type StudioFormat } from '@/lib/client/format';

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

type OutboxT = ReturnType<typeof useTranslations<'review.outbox'>>;

function stateText(row: OutboxRow, t: OutboxT, f: StudioFormat): string {
  switch (row.state) {
    case 'SENT':
      return t('sent');
    case 'SENDING':
      return t('sending');
    case 'PENDING': {
      if (row.attempts === 0) return t('pending');
      const attempt = { attempt: row.attempts + 1, max: row.maxAttempts };
      return row.nextAttemptAt
        ? t('retryingAt', { ...attempt, date: f.date(row.nextAttemptAt) })
        : t('retryingSoon', attempt);
    }
    case 'FAILED':
      return t('failed', { count: row.attempts });
  }
}

export function AutoPublishOutbox({ projectId }: { projectId: string }) {
  const t = useTranslations('review.outbox');
  const f = useFormat();
  const errorMessage = useErrorMessage();
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
      toast.success(t('requeued', { count: out.requeued }));
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-2" aria-label={t('title')}>
      <p className="text-xs font-medium text-muted-foreground">{t('title')}</p>
      <ul className="grid gap-1 text-sm">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5"
          >
            <span>{f.platform(row.target.platform)}</span>
            <span className={row.state === 'FAILED' ? 'text-destructive' : undefined}>
              {stateText(row, t, f)}
              {row.state !== 'SENT' && row.lastError && ` — ${row.lastError}`}
            </span>
          </li>
        ))}
      </ul>
      {failed > 0 && (
        <div>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void retry()}>
            {pending ? <Loader2 className="animate-spin" /> : <RotateCw />}
            {t('retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
