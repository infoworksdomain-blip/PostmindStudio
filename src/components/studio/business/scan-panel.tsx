'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { Loader2, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  api,
  ApiError,
  apiPath,
  newIdempotencyKey,
  useApi,
  useErrorMessage,
} from '@/lib/client/api';
import { useFormat, type Tone } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { FailureReason } from '../failure-reason';
import { ErrorState, Section, StateBadge } from '../primitives';
import { DomainVerificationCard } from './domain-verification';
import { ScanScheduleLine } from './scan-schedule';
import {
  ACTIVE_SCAN_STATES,
  type ImageSource,
  type ScanDetail,
  type ScanState,
  type WebsiteScan,
} from './types';

// A6.1 / A6.8 — scan the business website: start a scan (with the A6.7 ownership warranty),
// poll the running scan, and show scan history. 13.10: the automatic rescan schedule line;
// 13.11: DNS ownership verification (Enterprise) and "I don't own this site".

export const SCAN_POLL_MS = 3_000;

/**
 * A6.7 / A11.2 — the ownership warranty. The checkbox shows the catalogue text
 * business.scan.ownershipStatement in the interface language; 17.8: the scan request sends
 * { locale, messageKey, text } and the server stores the approved text for that locale and key
 * (refusing anything else), so the scan record keeps what the user agreed to. This constant is
 * the en-GB wording.
 */
export const OWNERSHIP_STATEMENT_KEY = 'business.scan.ownershipStatement';

export const OWNERSHIP_STATEMENT =
  'I own this website or am authorised to represent it, including its images.';

const SCAN_STATE_TONE: Record<ScanState, Tone> = {
  QUEUED: 'live',
  RUNNING: 'live',
  SUCCEEDED: 'good',
  FAILED: 'bad',
};

const LIBRARY_SOURCES: ReadonlySet<string> = new Set<ImageSource>([
  'SCRAPED',
  'STOCK',
  'GENERATED',
  'UPLOAD',
]);

function isImageSource(source: string): source is ImageSource {
  return LIBRARY_SOURCES.has(source);
}

function ScanStateBadge({ state }: { state: ScanState }) {
  const t = useTranslations('business.scan.states');
  return <StateBadge label={t(state)} tone={SCAN_STATE_TONE[state]} />;
}

function ScanProgress({ scanId, onSettled }: { scanId: string; onSettled: () => void }) {
  const t = useTranslations('business.scan');
  const f = useFormat();
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
  if (!data) return <Skeleton aria-label={t('loadingScan')} className="h-28 rounded-xl" />;
  const { scan } = data;
  const total = Object.values(scan.library).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <div aria-live="polite" className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">{scan.url}</p>
        <ScanStateBadge state={scan.state} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('pagesRead')}</dt>
          <dd className="tabular font-display text-3xl leading-none">
            {f.number(scan.pagesCrawled)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('imagesFromSite')}</dt>
          <dd className="tabular font-display text-3xl leading-none">
            {f.number(scan.imagesIngested)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('imageLibrary')}</dt>
          <dd className="tabular font-display text-3xl leading-none">{f.number(total)}</dd>
        </div>
      </dl>
      {!active && total > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {Object.entries(scan.library)
            .map(([source, n]) =>
              isImageSource(source)
                ? t(`librarySources.${source}`, { count: n ?? 0 })
                : `${f.number(n)} ${source.toLowerCase()}`,
            )
            .join(' · ')}
        </p>
      )}
      {scan.robotsBlocked && <p className="mt-3 text-xs text-muted-foreground">{t('robots')}</p>}
      {scan.errors.length > 0 && (
        // A finished scan's lines are notes about what it skipped (muted); a failed scan's are
        // the reason it failed (red). Identical lines (rows stored before the worker coded them
        // all read "This step failed") show once.
        <ul
          className={cn(
            'mt-3 list-disc ps-5 text-xs',
            scan.state === 'FAILED' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {[...new Set(scan.errors)].map((e) => (
            <li key={e}>
              <FailureReason reason={e} plain />
            </li>
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
  const t = useTranslations('business.scan');
  const errorMessage = useErrorMessage();
  const locale = useLocale();
  const ownershipStatement = t('ownershipStatement');
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
            ownershipStatement: {
              locale,
              messageKey: OWNERSHIP_STATEMENT_KEY,
              text: ownershipStatement,
            },
          },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      toast.success(t('started'));
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
        <Label htmlFor="scan-url">{t('urlLabel')}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="scan-url"
            inputMode="url"
            placeholder={t('urlPlaceholder')}
            maxLength={2000}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={!url.trim() || !owner || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ScanSearch />} {t('submit')}
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
          {ownershipStatement}
        </Label>
      </div>
      {/* 14.4: the browser-render fallback policy, stated where the confirmation is given. */}
      <p className="text-muted-foreground text-xs leading-snug" data-testid="scan-render-policy">
        {t('renderPolicy')}
      </p>
    </form>
  );
}

export function ScanPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('business.scan');
  const f = useFormat();
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
    <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
      <div className="grid content-start gap-10">
        <Section title={t('title')} description={t('description')}>
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
      <Section title={t('history')}>
        {error && <ErrorState error={error} onRetry={() => void mutate()} />}
        {isLoading && <Skeleton aria-label={t('loadingHistory')} className="h-24" />}
        {data && data.data.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noScans')}</p>
        )}
        {data && data.data.length > 0 && (
          <ul className="divide-y divide-border/70" aria-label={t('history')}>
            {data.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{s.url}</span>
                  <span className="block text-xs text-muted-foreground" title={f.date(s.startedAt)}>
                    {t('historyRow', {
                      when: f.relative(s.startedAt),
                      pages: s.pagesCrawled,
                      images: s.imagesIngested,
                    })}
                  </span>
                </span>
                <ScanStateBadge state={s.state} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
