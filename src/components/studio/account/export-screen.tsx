'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, PackageOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section, StateBadge } from '../primitives';

// BACKLOG 15.E1 — studio.postmind.ai/account/export (spec 18.4 right of access). Request a ZIP
// of the organisation's Studio data; it is prepared in the background and the download link lasts
// 7 days. Data: GET|POST /api/studio/account/export, GET /api/studio/account/export/:id.

export interface ExportItem {
  id: string;
  state: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
  include: string[];
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  bytes: number | null;
  errorReason: string | null;
  downloadUrl?: string;
}

/** Export groups (API keys) and their catalogue keys (account.export.groups.<key>). */
export const GROUPS = [
  { key: 'projects', label: 'projects' },
  { key: 'analytics', label: 'analytics' },
  { key: 'brand', label: 'brand' },
  { key: 'image_library', label: 'imageLibrary' },
] as const;

type GroupLabel = (typeof GROUPS)[number]['label'];

const STATE = {
  QUEUED: { label: 'queued', tone: 'live' },
  RUNNING: { label: 'running', tone: 'live' },
  READY: { label: 'ready', tone: 'good' },
  FAILED: { label: 'failed', tone: 'bad' },
  EXPIRED: { label: 'expired', tone: 'neutral' },
} as const;

function groupLabel(key: string): GroupLabel | undefined {
  return GROUPS.find((g) => g.key === key)?.label;
}

function DownloadButton({ id }: { id: string }) {
  const t = useTranslations('account.export');
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const res = await api<{ export: ExportItem }>(`/account/export/${encodeURIComponent(id)}`);
      if (res.export.downloadUrl) window.location.assign(res.export.downloadUrl);
      else toast.error(t('noLongerAvailable'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={() => void open()} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />} {t('download')}
    </Button>
  );
}

export function ExportScreen() {
  const t = useTranslations('account.export');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const includedLabels = (keys: string[]) =>
    f.list(
      keys.map((k) => {
        const label = groupLabel(k);
        return label ? t(`groups.${label}.label`) : k;
      }),
    );
  const { data, error, isLoading, mutate } = useApi<{ data: ExportItem[] }>(
    '/account/export',
    undefined,
    {
      refreshInterval: (latest) =>
        latest?.data.some((e) => e.state === 'QUEUED' || e.state === 'RUNNING') ? 3_000 : 0,
    },
  );
  const [include, setInclude] = useState<string[]>(GROUPS.map((g) => g.key));
  const [busy, setBusy] = useState(false);
  const running = data?.data.some((e) => e.state === 'QUEUED' || e.state === 'RUNNING') ?? false;

  const request = async () => {
    setBusy(true);
    try {
      await api('/account/export', {
        method: 'POST',
        body: { include },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('requested'));
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string, on: boolean) =>
    setInclude((current) => (on ? [...current, key] : current.filter((k) => k !== key)));

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Section title={t('newExport')}>
          <fieldset className="grid gap-3">
            <legend className="sr-only">{t('includeLegend')}</legend>
            {GROUPS.map((g) => (
              <label key={g.key} className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={include.includes(g.key)}
                  onCheckedChange={(v) => toggle(g.key, v === true)}
                  aria-label={t(`groups.${g.label}.label`)}
                />
                <span>
                  <span className="font-medium">{t(`groups.${g.label}.label`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`groups.${g.label}.hint`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button
            className="mt-4"
            onClick={() => void request()}
            disabled={busy || running || include.length === 0}
          >
            {busy ? <Loader2 className="animate-spin" /> : <PackageOpen />}
            {running ? t('preparing') : t('request')}
          </Button>
        </Section>
        <Section title={t('yourExports')} description={t('linksExpire', { days: 7 })}>
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && <Skeleton aria-label={t('loading')} className="h-32 rounded-lg" />}
          {data && data.data.length === 0 && (
            <EmptyState title={t('empty.title')} description={t('empty.description')} />
          )}
          {data && data.data.length > 0 && (
            <ul aria-label={t('listAria')} className="grid gap-2">
              {data.data.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <StateBadge
                      label={t(`states.${STATE[e.state].label}`)}
                      tone={STATE[e.state].tone}
                    />
                    <span>{f.date(e.createdAt)}</span>
                    <span className="text-muted-foreground">{includedLabels(e.include)}</span>
                    {e.bytes !== null && (
                      <span className="text-muted-foreground tabular">
                        {t('sizeKb', { kb: Math.round(e.bytes / 1024) })}
                      </span>
                    )}
                    {e.state === 'FAILED' && e.errorReason && (
                      <span className="text-destructive">{e.errorReason}</span>
                    )}
                  </span>
                  {e.state === 'READY' && <DownloadButton id={e.id} />}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
