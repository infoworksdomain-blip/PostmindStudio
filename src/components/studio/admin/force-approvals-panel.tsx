'use client';

import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { useProjectName } from '@/lib/client/use-project-name';

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
  const t = useTranslations('admin.forceApprovals');
  const f = useFormat();
  const projectName = useProjectName();
  const [days, setDays] = useState<number>(30);
  const res = useApi<Response>('/admin/force-approvals', { days });
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <select
          aria-label={t('windowAria')}
          className={selectClass}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {WINDOWS.map((d) => (
            <option key={d} value={d}>
              {t('window', { days: d })}
            </option>
          ))}
        </select>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label={t('loadingAria')} className="h-40" />
      ) : res.data.items.length === 0 ? (
        <EmptyState
          icon={<BadgeCheck className="size-8" strokeWidth={1.5} />}
          title={t('emptyTitle')}
          description={t('emptyBody', { days })}
        />
      ) : (
        <>
          <ul aria-label={t('listAria')} className="divide-y divide-border/70">
            {res.data.items.map((item) => (
              <li key={item.renderId} className="grid gap-1 py-3 text-sm">
                <p className="font-medium">
                  {projectName(item.project.name)}
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    {t('meta', {
                      platform: f.platform(item.targetPlatform),
                      aspect: item.aspectRatio,
                      state: f.projectState(item.project.state).label,
                    })}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.rich('byLine', {
                    organisationId: item.organisationId,
                    user: item.approvedByUserId ?? t('unknownUser'),
                    date: f.date(item.approvedAt),
                    mono: (chunks) => <span className="font-mono">{chunks}</span>,
                  })}
                  {!item.approvedAtRecorded && <> {t('renderTimeNote')}</>}
                </p>
                <p>
                  <span className="text-muted-foreground">{t('note')}</span>{' '}
                  {t('quotedNote', { note: item.note ?? '—' })}
                </p>
                <p className="text-xs">
                  <span className="text-muted-foreground">{t('failedChecks')}</span>{' '}
                  {item.failedChecks.length === 0
                    ? t('noneRecorded')
                    : item.failedChecks
                        .map((c) => t('check', { code: c.code, detail: c.detail }))
                        .join('; ')}
                </p>
              </li>
            ))}
          </ul>
          {res.data.truncated && (
            <p className="mt-2 text-xs text-muted-foreground">{t('truncated')}</p>
          )}
        </>
      )}
    </Section>
  );
}
