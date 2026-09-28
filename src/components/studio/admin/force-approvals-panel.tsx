'use client';

import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { EmptyState, ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';

// BACKLOG 15.D5 / spec 13.5 — "Every force-approve is audited and reviewable in the Admin
// Centre." GET /admin/force-approvals?days=: renders a customer pushed past a failed quality
// gate, with their note, who did it and which checks had failed.

export interface ForceApproval {
  renderId: string;
  targetPlatform: string;
  aspectRatio: string;
  renderCreatedAt: string;
  approvedAt: string;
  approvedAtRecorded: boolean;
  approvedByUserId: string | null;
  note: string | null;
  failedChecks: Array<{ code: string; severity: string; detail: string }>;
  project: { id: string; name: string; state: string; businessId: string };
  organisationId: string;
}

interface Response {
  ok: true;
  days: number;
  since: string;
  truncated: boolean;
  items: ForceApproval[];
}

const WINDOWS = [7, 30, 90] as const;

export function ForceApprovalsPanel() {
  const [days, setDays] = useState<number>(30);
  const res = useApi<Response>('/admin/force-approvals', { days });
  return (
    <Section
      title="Force-approvals"
      description="Quality-gate failures a customer overrode with studio:render:force-approve (spec 13.5). Content-safety blocks can never be force-approved."
      actions={
        <select
          aria-label="Window"
          className={selectClass}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {WINDOWS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label="Loading force-approvals" className="h-40" />
      ) : res.data.items.length === 0 ? (
        <EmptyState
          icon={<BadgeCheck className="size-8" strokeWidth={1.5} />}
          title="No force-approvals"
          description={`No render was force-approved in the last ${days} days.`}
        />
      ) : (
        <>
          <ul aria-label="Force-approvals" className="divide-y divide-border/70">
            {res.data.items.map((item) => (
              <li key={item.renderId} className="grid gap-1 py-3 text-sm">
                <p className="font-medium">
                  {item.project.name}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {item.targetPlatform} {item.aspectRatio} · project {item.project.state}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Organisation {item.organisationId} · by{' '}
                  <span className="font-mono">{item.approvedByUserId ?? 'unknown user'}</span> ·{' '}
                  {formatDate(item.approvedAt)}
                  {!item.approvedAtRecorded && ' (render time; approval time not recorded)'}
                </p>
                <p>
                  <span className="text-muted-foreground">Note: </span>“{item.note ?? '—'}”
                </p>
                <p className="text-xs">
                  <span className="text-muted-foreground">Failed checks: </span>
                  {item.failedChecks.length === 0
                    ? 'none recorded'
                    : item.failedChecks.map((c) => `${c.code} (${c.detail})`).join('; ')}
                </p>
              </li>
            ))}
          </ul>
          {res.data.truncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing the most recent entries only; narrow the window or filter by organisation.
            </p>
          )}
        </>
      )}
    </Section>
  );
}
