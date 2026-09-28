'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, PackageOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
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

export const GROUPS = [
  {
    key: 'projects',
    label: 'Projects',
    hint: 'Briefs, scripts, shots, renders, publications and media links',
  },
  { key: 'analytics', label: 'Analytics', hint: 'Views and engagement per post, provider spend' },
  {
    key: 'brand',
    label: 'Brand',
    hint: 'Brand kits, voices, style memory, business profile, templates',
  },
  { key: 'image_library', label: 'Image library', hint: 'Every image and its source' },
] as const;

const STATE = {
  QUEUED: { label: 'Queued', tone: 'live' },
  RUNNING: { label: 'Preparing', tone: 'live' },
  READY: { label: 'Ready', tone: 'good' },
  FAILED: { label: 'Failed', tone: 'bad' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
} as const;

function DownloadButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const res = await api<{ export: ExportItem }>(`/account/export/${encodeURIComponent(id)}`);
      if (res.export.downloadUrl) window.location.assign(res.export.downloadUrl);
      else toast.error('This export is no longer available');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={() => void open()} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />} Download
    </Button>
  );
}

export function ExportScreen() {
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
      toast.success('Export requested — we will prepare it in the background');
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
      <PageHeader
        eyebrow="Account"
        title="Export your data"
        description="Download everything Studio holds for your organisation as a ZIP of JSON files with links to your media. Access tokens and other secrets are never included."
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Section title="New export">
          <fieldset className="grid gap-3">
            <legend className="sr-only">What to include</legend>
            {GROUPS.map((g) => (
              <label key={g.key} className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={include.includes(g.key)}
                  onCheckedChange={(v) => toggle(g.key, v === true)}
                  aria-label={g.label}
                />
                <span>
                  <span className="font-medium">{g.label}</span>
                  <span className="block text-xs text-muted-foreground">{g.hint}</span>
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
            {running ? 'An export is being prepared' : 'Request export'}
          </Button>
        </Section>
        <Section title="Your exports" description="Links expire 7 days after an export is ready.">
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && <Skeleton aria-label="Loading exports" className="h-32 rounded-lg" />}
          {data && data.data.length === 0 && (
            <EmptyState title="No exports yet" description="Request one to download your data." />
          )}
          {data && data.data.length > 0 && (
            <ul aria-label="Exports" className="grid gap-2">
              {data.data.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <StateBadge {...STATE[e.state]} />
                    <span>{formatDate(e.createdAt)}</span>
                    <span className="text-muted-foreground">{e.include.join(', ')}</span>
                    {e.bytes !== null && (
                      <span className="text-muted-foreground tabular">
                        {(e.bytes / 1024).toFixed(0)} KB
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
