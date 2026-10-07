'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section, Stat } from '../primitives';
import { ReasonDialog } from './reason-dialog';

// BACKLOG 14.11 — Admin → Safety audit: the Trust & Safety monthly audit (runbooks/
// content-safety-miss.md). A job samples N videos published last month; staff re-check each one
// and record Pass or Miss (a miss needs a note, notifies staff and counts towards the "safety
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
  const t = useTranslations('admin.safety.audit');
  const ts = useTranslations('admin.safety');
  const f = useFormat();
  const link = safeHttpUrl(item.platformUrl);
  const platform = f.platform(item.platform);
  const resultLabel = t(`result.${item.result}`);
  return (
    <li className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[minmax(0,200px)_1fr]">
      {item.previewUrl ? (
        <video
          src={item.previewUrl}
          controls
          muted
          preload="metadata"
          aria-label={t('videoAria', { platform })}
          className="aspect-[9/16] max-h-64 w-full rounded-md bg-black object-contain"
        />
      ) : (
        <div className="grid aspect-[9/16] max-h-64 place-items-center rounded-md bg-muted text-xs text-muted-foreground">
          {t('noPreview')}
        </div>
      )}
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">
          {platform}
          <span className="ms-2 text-xs font-normal text-muted-foreground">
            {t('publishedOn', { date: f.date(item.publishedAt) })}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {t('ids', { organisationId: item.organisationId, projectId: item.projectId })}
        </p>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t('openPost')} <ExternalLink className="size-3 rtl:-scale-x-100" />
          </a>
        )}
        {item.result === 'pending' ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={onPass} loading={busy}>
              {t('pass')}
            </Button>
            <Button size="sm" variant="destructive" onClick={onMiss} disabled={busy}>
              {t('miss')}
            </Button>
          </div>
        ) : (
          <p className={item.result === 'miss' ? 'text-xs text-destructive' : 'text-xs'}>
            {item.reviewedAt
              ? ts('decidedWhen', { state: resultLabel, when: f.relative(item.reviewedAt) })
              : resultLabel}
            {item.note && <> — {ts('quotedNote', { note: item.note })}</>}
          </p>
        )}
      </div>
    </li>
  );
}

export function SafetyAuditPanel() {
  const t = useTranslations('admin.safety.audit');
  const f = useFormat();
  const errorMessage = useErrorMessage();
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
      toast.success(verdict === 'pass' ? t('passToast') : t('missToast'));
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
        t('sampleToast', {
          added: f.number(out.sample.added),
          total: f.number(out.sample.total),
          population: out.sample.population,
        }),
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
      title={t('title')}
      description={t('description')}
      actions={
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            size="sm"
            wrapperClassName="w-auto"
            aria-label={t('monthAria')}
            value={shown}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            size="sm"
            wrapperClassName="w-auto"
            aria-label={t('resultAria')}
            value={result}
            onChange={(e) => setResult(e.target.value as Result | '')}
          >
            <option value="pending">{t('filter.pending')}</option>
            <option value="miss">{t('filter.miss')}</option>
            <option value="pass">{t('filter.pass')}</option>
            <option value="">{t('filter.all')}</option>
          </NativeSelect>
          <Button size="sm" variant="outline" onClick={() => void drawSample()} loading={sampling}>
            {t('drawSample')}
          </Button>
        </div>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label={t('loadingAria')} className="h-64" />
      ) : (
        <div className="grid gap-6">
          <div className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat label={t('sampled')} value={f.number(res.data.summary.sampled)} />
            <Stat label={t('waiting')} value={f.number(res.data.summary.pending)} />
            <Stat label={t('passed')} value={f.number(res.data.summary.passed)} />
            <Stat label={t('missed')} value={f.number(res.data.summary.missed)} />
            <Stat
              label={t('missRate')}
              value={
                res.data.summary.missRate === null
                  ? '—'
                  : f.number(res.data.summary.missRate, {
                      style: 'percent',
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })
              }
              hint={t('missRateHint')}
            />
          </div>
          {res.data.data.length === 0 ? (
            <EmptyState
              title={res.data.summary.sampled === 0 ? t('emptyNoSampleTitle') : t('emptyTitle')}
              description={res.data.summary.sampled === 0 ? t('emptyNoSampleBody') : t('emptyBody')}
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
        title={t('missTitle')}
        description={t('missBody')}
        confirmLabel={t('missConfirm')}
        destructive
        onConfirm={async (note) => (missing ? record(missing, 'miss', note) : false)}
      />
    </Section>
  );
}
