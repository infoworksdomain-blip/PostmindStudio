'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section, Stat } from '../primitives';
import { ResubmitFailures } from './resubmit-failures';
import type { IngestRunState, IngestStatusResponse } from './types';

// Corpus ingestion monitor (BACKLOG 9.2/9.3, runbooks/corpus-ingestion.md): counts by state over
// a window, open backlog, throughput and the latest failures with their reasons. Refreshes every
// 30 seconds while the tab is open.

const WINDOWS = [
  { hours: 1, label: 'windowHour' },
  { hours: 24, label: 'windowDay' },
  { hours: 24 * 7, label: 'windowWeek' },
] as const;
const REFRESH_MS = 30_000;
const STATES = [
  'SUCCEEDED',
  'DUPLICATE',
  'FAILED',
  'RUNNING',
  'QUEUED',
] as const satisfies ReadonlyArray<IngestRunState>;

export function IngestStatus() {
  const t = useTranslations('admin.library.status');
  const f = useFormat();
  const [windowHours, setWindowHours] = useState(24);
  const { data, error, isLoading, mutate, isValidating } = useApi<IngestStatusResponse>(
    '/admin/library/ingest/status',
    { windowHours, failures: 10 },
    { refreshInterval: REFRESH_MS },
  );

  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <div className="flex items-center gap-2">
          <label htmlFor="ingest-status-window" className="sr-only">
            {t('window')}
          </label>
          <NativeSelect
            size="sm"
            wrapperClassName="w-auto"
            id="ingest-status-window"
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {t(w.label)}
              </option>
            ))}
          </NativeSelect>
          <ResubmitFailures failed={data?.counts.FAILED ?? 0} onDone={() => void mutate()} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void mutate()}
            disabled={isValidating}
            aria-label={t('refreshAria')}
          >
            <RotateCw className={isValidating ? 'animate-spin' : undefined} />
          </Button>
        </div>
      }
    >
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-24 rounded-lg" />}
      {data && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          <div
            role="group"
            aria-label={t('countsAria')}
            className="grid grid-cols-2 gap-4 sm:grid-cols-5"
          >
            {STATES.map((state) => (
              <div key={state}>
                <Stat label={t(state)} value={data.counts[state]} />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('backlog', {
              queued: f.number(data.backlog.queued),
              running: f.number(data.backlog.running),
              perHour: f.number(data.completedPerHour),
              live: f.number(data.liveLibraryItems),
            })}
          </p>
          {data.recentFailures.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold">{t('recentFailures')}</h3>
              <ul aria-label={t('failuresAria')} className="divide-y divide-border/70">
                {data.recentFailures.map((failure) => (
                  <li key={failure.runId} className="py-2 text-xs">
                    <p className="truncate font-mono" title={failure.sourceUrl}>
                      {[failure.sourceRef, failure.sourceUrl].filter(Boolean).join(' · ')}
                    </p>
                    <p className="break-words text-destructive">
                      {failure.errorReason ?? t('unknownError')}
                      <span className="text-muted-foreground">
                        {' · '}
                        {t('attempts', { count: failure.attempts })}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
