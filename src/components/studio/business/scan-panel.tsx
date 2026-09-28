'use client';

import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { Loader2, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, apiPath, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate, relativeTime, type Tone } from '@/lib/client/format';
import { ErrorState, Section, StateBadge } from '../primitives';
import { DomainVerificationCard } from './domain-verification';
import { ScanScheduleLine } from './scan-schedule';
import { ACTIVE_SCAN_STATES, type ScanDetail, type ScanState, type WebsiteScan } from './types';

// A6.1 / A6.8 — scan the business website: start a scan (with the A6.7 ownership warranty),
// poll the running scan, and show scan history. 13.10: the automatic rescan schedule line;
// 13.11: DNS ownership verification (Enterprise) and "I don't own this site".

export const SCAN_POLL_MS = 3_000;

/**
 * A6.7 / A11.2 — the ownership warranty. The checkbox shows exactly this text and the scan
 * request sends it (ownershipStatement), so the scan record keeps what the user agreed to.
 */
export const OWNERSHIP_STATEMENT =
  'I own this website or am authorised to represent it, including its images.';

const SCAN_STATE: Record<ScanState, { label: string; tone: Tone }> = {
  QUEUED: { label: 'Queued', tone: 'live' },
  RUNNING: { label: 'Scanning your site', tone: 'live' },
  SUCCEEDED: { label: 'Done', tone: 'good' },
  FAILED: { label: 'Failed', tone: 'bad' },
};

const SOURCE_LABEL: Record<string, string> = {
  SCRAPED: 'from your site',
  STOCK: 'stock',
  GENERATED: 'generated',
  UPLOAD: 'uploaded',
};

function ScanProgress({ scanId, onSettled }: { scanId: string; onSettled: () => void }) {
  const { data, error } = useApi<{ scan: ScanDetail }>(`/scans/${scanId}`, undefined, {
    refreshInterval: (latest) =>
      latest && !ACTIVE_SCAN_STATES.has(latest.scan.state) ? 0 : SCAN_POLL_MS,
  });
  const state = data?.scan.state;
  const active = state ? ACTIVE_SCAN_STATES.has(state) : true;
  // Fire onSettled once, on the transition from running to finished (not for old scans).
  const sawActive = useRef(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    if (!state) return;
    if (ACTIVE_SCAN_STATES.has(state)) sawActive.current = true;
    else if (sawActive.current) {
      sawActive.current = false;
      settled.current();
    }
  }, [state]);

  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton aria-label="Loading scan" className="h-28 rounded-xl" />;
  const { scan } = data;
  const total = Object.values(scan.library).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <div aria-live="polite" className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">{scan.url}</p>
        <StateBadge {...SCAN_STATE[scan.state]} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Pages read</dt>
          <dd className="tabular font-display text-3xl leading-none">{scan.pagesCrawled}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Images from your site</dt>
          <dd className="tabular font-display text-3xl leading-none">{scan.imagesIngested}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Image library</dt>
          <dd className="tabular font-display text-3xl leading-none">{total}</dd>
        </div>
      </dl>
      {!active && total > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {Object.entries(scan.library)
            .map(([source, n]) => `${n} ${SOURCE_LABEL[source] ?? source.toLowerCase()}`)
            .join(' · ')}
        </p>
      )}
      {scan.robotsBlocked && (
        <p className="mt-3 text-xs text-muted-foreground">
          Your site’s robots.txt asked us not to read some pages, so we skipped them.
        </p>
      )}
      {scan.errors.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-xs text-destructive">
          {scan.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScanForm({
  businessId,
  onStarted,
}: {
  businessId: string;
  onStarted: (id: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [owner, setOwner] = useState(false);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const res = await api<{ scanId: string }>(
        `/businesses/${encodeURIComponent(businessId)}/scan-website`,
        {
          method: 'POST',
          body: {
            url: url.trim(),
            ownershipConfirmed: true,
            ownershipStatement: OWNERSHIP_STATEMENT,
          },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      toast.success('Scan started — this takes 2–5 minutes');
      onStarted(res.scanId);
    } catch (err) {
      const running = err instanceof ApiError ? err.details?.scanId : undefined;
      if (typeof running === 'string') onStarted(running);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim() && owner) void start();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="scan-url">Website address</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="scan-url"
            inputMode="url"
            placeholder="yourbusiness.co.uk"
            maxLength={2000}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={!url.trim() || !owner || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ScanSearch />} Scan website
          </Button>
        </div>
      </div>
      <div className="flex items-start gap-2.5">
        <Checkbox
          id="scan-owner"
          checked={owner}
          onCheckedChange={(v) => setOwner(v === true)}
          className="mt-0.5"
        />
        <Label htmlFor="scan-owner" className="text-sm leading-snug font-normal">
          {OWNERSHIP_STATEMENT}
        </Label>
      </div>
    </form>
  );
}

export function ScanPanel({ businessId }: { businessId: string }) {
  const scansPath = `/businesses/${encodeURIComponent(businessId)}/scans`;
  const { data, error, isLoading, mutate } = useApi<{ data: WebsiteScan[] }>(scansPath);
  const { mutate: mutateGlobal } = useSWRConfig();
  const [started, setStarted] = useState<string | null>(null);
  const latest = data?.data[0];
  const focusId = started ?? latest?.id ?? null;

  const onSettled = () => {
    void mutate();
    // a finished scan (re)writes the business profile and fills the image library
    void mutateGlobal(apiPath(`/businesses/${encodeURIComponent(businessId)}/business-profile`));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <div className="grid content-start gap-6">
        <Section
          title="Scan your website"
          description="Studio reads your site, works out your niche and builds an image library from your pages, stock photos and generated images."
        >
          <div className="grid gap-4">
            <ScanForm
              businessId={businessId}
              onStarted={(id) => {
                setStarted(id);
                void mutate();
              }}
            />
            <ScanScheduleLine businessId={businessId} />
          </div>
        </Section>
        {focusId && <ScanProgress key={focusId} scanId={focusId} onSettled={onSettled} />}
        <DomainVerificationCard businessId={businessId} />
      </div>
      <Section title="Scan history">
        {error && <ErrorState error={error} onRetry={() => void mutate()} />}
        {isLoading && <Skeleton aria-label="Loading scans" className="h-24" />}
        {data && data.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No scans yet.</p>
        )}
        {data && data.data.length > 0 && (
          <ul className="divide-y divide-border/70" aria-label="Scan history">
            {data.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{s.url}</span>
                  <span
                    className="block text-xs text-muted-foreground"
                    title={formatDate(s.startedAt)}
                  >
                    {relativeTime(s.startedAt)} · {s.pagesCrawled} pages · {s.imagesIngested} images
                  </span>
                </span>
                <StateBadge {...SCAN_STATE[s.state]} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
