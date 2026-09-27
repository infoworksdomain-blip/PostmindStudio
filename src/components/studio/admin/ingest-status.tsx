'use client';

import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ErrorState, Section, Stat } from '../primitives';
import { selectClass } from '../library/library-filters';
import { ResubmitFailures } from './resubmit-failures';
import type { IngestRunState, IngestStatusResponse } from './types';

// Corpus ingestion monitor (BACKLOG 9.2/9.3, runbooks/corpus-ingestion.md): counts by state over
// a window, open backlog, throughput and the latest failures with their reasons. Refreshes every
// 30 seconds while the tab is open.

const WINDOWS = [
  { hours: 1, label: 'Last hour' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 24 * 7, label: 'Last 7 days' },
];
const REFRESH_MS = 30_000;
const STATES: Array<{ state: IngestRunState; label: string }> = [
  { state: 'SUCCEEDED', label: 'Ingested' },
  { state: 'DUPLICATE', label: 'Duplicates' },
  { state: 'FAILED', label: 'Failed' },
  { state: 'RUNNING', label: 'Running' },
  { state: 'QUEUED', label: 'Queued' },
];

export function IngestStatus() {
  const [windowHours, setWindowHours] = useState(24);
  const { data, error, isLoading, mutate, isValidating } = useApi<IngestStatusResponse>(
    '/admin/library/ingest/status',
    { windowHours, failures: 10 },
    { refreshInterval: REFRESH_MS },
  );

  return (
    <Section
      title="Ingestion status"
      description="Corpus jobs whose state changed in the window. Failed sources can be resubmitted."
      actions={
        <div className="flex items-center gap-2">
          <label htmlFor="ingest-status-window" className="sr-only">
            Window
          </label>
          <select
            id="ingest-status-window"
            className={selectClass}
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </select>
          <ResubmitFailures failed={data?.counts.FAILED ?? 0} onDone={() => void mutate()} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void mutate()}
            disabled={isValidating}
            aria-label="Refresh ingestion status"
          >
            <RotateCw className={isValidating ? 'animate-spin' : undefined} />
          </Button>
        </div>
      }
    >
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label="Loading ingestion status" className="h-24 rounded-lg" />}
      {data && (
        <div className="grid gap-5">
          <div
            role="group"
            aria-label="Ingestion counts"
            className="grid grid-cols-2 gap-4 sm:grid-cols-5"
          >
            {STATES.map(({ state, label }) => (
              <div key={state}>
                <Stat label={label} value={data.counts[state]} />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Backlog {data.backlog.queued} queued · {data.backlog.running} running ·{' '}
            {data.completedPerHour} completed per hour · {data.liveLibraryItems} live items in the
            library
          </p>
          {data.recentFailures.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold">Recent failures</h3>
              <ul aria-label="Recent ingestion failures" className="divide-y divide-border/70">
                {data.recentFailures.map((f) => (
                  <li key={f.runId} className="py-2 text-xs">
                    <p className="truncate font-mono" title={f.sourceUrl}>
                      {f.sourceRef ? `${f.sourceRef} · ` : ''}
                      {f.sourceUrl}
                    </p>
                    <p className="text-destructive">
                      {f.errorReason ?? 'Unknown error'}
                      <span className="text-muted-foreground">
                        {' '}
                        · {f.attempts} attempt{f.attempts === 1 ? '' : 's'}
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
