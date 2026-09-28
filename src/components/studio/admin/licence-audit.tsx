'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section, StateBadge, Stat } from '../primitives';
import { LICENCE_TONE, type LicenceAuditResponse } from './library-admin-types';
import type { LicenseScenario } from './types';

// 15.D7 / A3.8 "Licence-status audit — every item must have a licence row" (A11.1: rows without
// one never reach users). GET /admin/library/licence-audit over the live corpus.

const SCENARIO_LABEL = {
  LICENSED: 'scenarioLicensed',
  OWNED: 'scenarioOwned',
  SCRAPED: 'scenarioScraped',
  NOT_REQUIRED: 'scenarioNotRequired',
} as const satisfies Record<LicenseScenario, string>;
const PROBLEMS_SHOWN = 20;

export function LicenceAudit({ onShowMissing }: { onShowMissing: () => void }) {
  const t = useTranslations('admin.library.audit');
  const tl = useTranslations('admin.library');
  const f = useFormat();
  const { data, error, isLoading, mutate } = useApi<LicenceAuditResponse>(
    '/admin/library/licence-audit',
    { limit: PROBLEMS_SHOWN },
  );
  return (
    <Section
      title={t('title')}
      description={
        data
          ? t('descriptionLoaded', {
              date: f.date(data.generatedAt),
              days: data.expiringWithinDays,
            })
          : t('descriptionEmpty')
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => void mutate()}>
          {t('refresh')}
        </Button>
      }
    >
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-24 rounded-lg" />}
      {data && (
        <div className="grid gap-5">
          <div role="group" aria-label={t('problemsAria')} className="grid grid-cols-3 gap-4">
            <Stat label={t('missing')} value={data.missing} hint={t('missingHint')} />
            <Stat label={t('expired')} value={data.expired} hint={t('expiredHint')} />
            <Stat label={t('expiringSoon')} value={data.expiringSoon} />
          </div>
          <dl
            aria-label={t('byScenarioAria')}
            className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4"
          >
            {(Object.keys(SCENARIO_LABEL) as LicenseScenario[]).map((s) => (
              <div key={s} className="flex justify-between gap-2 border-b border-border/60 py-1">
                <dt className="text-muted-foreground">{t(SCENARIO_LABEL[s])}</dt>
                <dd className="tabular">{f.number(data.byScenario[s] ?? 0)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {t('liveRetired', { live: f.number(data.live), retired: f.number(data.retired) })}
          </p>
          {data.problems.length > 0 && (
            <div className="grid gap-2">
              <ul aria-label={t('problemsListAria')} className="divide-y divide-border/70">
                {data.problems.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{p.title}</span>
                    <span className="flex items-center gap-2">
                      {p.licenseExpires && (
                        <span className="text-xs text-muted-foreground">
                          {f.date(p.licenseExpires)}
                        </span>
                      )}
                      <StateBadge
                        label={tl(`licenceBadge.${p.problem}`)}
                        tone={LICENCE_TONE[p.problem]}
                      />
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
                  {t('showMissing')}
                </Button>
              )}
              {data.problemsTruncated && (
                <p className="text-xs text-muted-foreground">
                  {t('truncated', { count: PROBLEMS_SHOWN })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
