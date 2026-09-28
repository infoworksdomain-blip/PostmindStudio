'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { ErrorState, Section, StateBadge, Stat } from '../primitives';
import { LICENCE_BADGE, type LicenceAuditResponse } from './library-admin-types';
import type { LicenseScenario } from './types';

// 15.D7 / A3.8 "Licence-status audit — every item must have a licence row" (A11.1: rows without
// one never reach users). GET /admin/library/licence-audit over the live corpus.

const SCENARIO_LABEL: Record<LicenseScenario, string> = {
  LICENSED: 'Licensed',
  OWNED: 'Owned',
  SCRAPED: 'Scraped (INSPIRE only)',
  NOT_REQUIRED: 'Not required',
};

export function LicenceAudit({ onShowMissing }: { onShowMissing: () => void }) {
  const { data, error, isLoading, mutate } = useApi<LicenceAuditResponse>(
    '/admin/library/licence-audit',
    { limit: 20 },
  );
  return (
    <Section
      title="Licence audit"
      description={
        data
          ? `Live corpus, ${formatDate(data.generatedAt)} · expiring = within ${data.expiringWithinDays} days`
          : 'Every corpus item must have a licence row.'
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => void mutate()}>
          Refresh
        </Button>
      }
    >
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label="Loading licence audit" className="h-24 rounded-lg" />}
      {data && (
        <div className="grid gap-5">
          <div role="group" aria-label="Licence problems" className="grid grid-cols-3 gap-4">
            <Stat label="No licence row" value={data.missing} hint="never shown to users" />
            <Stat label="Expired" value={data.expired} hint="TEMPLATE blocked" />
            <Stat label="Expiring soon" value={data.expiringSoon} />
          </div>
          <dl
            aria-label="Live items by licence"
            className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4"
          >
            {(Object.keys(SCENARIO_LABEL) as LicenseScenario[]).map((s) => (
              <div key={s} className="flex justify-between gap-2 border-b border-border/60 py-1">
                <dt className="text-muted-foreground">{SCENARIO_LABEL[s]}</dt>
                <dd className="tabular">{data.byScenario[s] ?? 0}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {data.live} live · {data.retired} retired
          </p>
          {data.problems.length > 0 && (
            <div className="grid gap-2">
              <ul aria-label="Licence problems list" className="divide-y divide-border/70">
                {data.problems.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{p.title}</span>
                    <span className="flex items-center gap-2">
                      {p.licenseExpires && (
                        <span className="text-xs text-muted-foreground">
                          {formatDate(p.licenseExpires)}
                        </span>
                      )}
                      <StateBadge {...LICENCE_BADGE[p.problem]} />
                    </span>
                  </li>
                ))}
              </ul>
              {data.missing > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  onClick={onShowMissing}
                >
                  List unlicensed items
                </Button>
              )}
              {data.problemsTruncated && (
                <p className="text-xs text-muted-foreground">Showing the oldest 20 problems.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
