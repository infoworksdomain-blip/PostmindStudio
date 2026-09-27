'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Globe, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, errorMessage, useApi } from '@/lib/client/api';
import { formatDate, type Tone } from '@/lib/client/format';
import { Section, StateBadge } from '../primitives';
import { DisputeOwnership } from './dispute-ownership';

// BACKLOG 13.11 (Addendum A6.7, Enterprise) — "Verify with DNS": the user publishes a TXT record
// and Studio checks it every 10 minutes. POST|GET /businesses/:id/domain-verification.

export type DomainState = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'DISPUTED' | 'PURGED';

export interface DomainVerification {
  id: string;
  domain: string;
  record: string;
  recordType: 'TXT';
  value: string;
  state: DomainState;
  checkAttempts: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  verifiedAt: string | null;
  expiresAt: string;
  disputedAt: string | null;
  purgedAt: string | null;
}

const STATE: Record<DomainState, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting for DNS', tone: 'live' },
  VERIFIED: { label: 'Verified', tone: 'good' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  DISPUTED: { label: 'Ownership disputed', tone: 'bad' },
  PURGED: { label: 'Scraped content removed', tone: 'bad' },
};

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm">{value}</code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(value)
              .then(() => toast.success('Copied'))
              .catch(() => toast.error('Copy failed — select the text instead'))
          }
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

function RequestForm({ businessId, onDone }: { businessId: string; onDone: () => void }) {
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setRefused(null);
        try {
          await api(`/businesses/${encodeURIComponent(businessId)}/domain-verification`, {
            method: 'POST',
            body: { domain: domain.trim() },
          });
          onDone();
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) setRefused(err.message);
          else toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Label htmlFor="verify-domain">Domain to verify</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="verify-domain"
          placeholder="yourbusiness.co.uk"
          value={domain}
          maxLength={253}
          onChange={(e) => setDomain(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!domain.trim() || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Globe />} Verify with DNS
        </Button>
      </div>
      {refused && (
        <p role="alert" className="text-sm text-muted-foreground">
          {refused}.
        </p>
      )}
    </form>
  );
}

export function DomainVerificationCard({ businessId }: { businessId: string }) {
  const path = `/businesses/${encodeURIComponent(businessId)}/domain-verification`;
  const { data, error, mutate } = useApi<{ verification: DomainVerification }>(path, undefined, {
    shouldRetryOnError: false,
    refreshInterval: (latest) => (latest?.verification?.state === 'PENDING' ? 60_000 : 0),
  });
  const v = data?.verification;
  const none = error instanceof ApiError && error.status === 404;
  const again = !v || v.state === 'EXPIRED';

  return (
    <Section
      title="Prove you own the site"
      description="Enterprise: add a DNS TXT record to prove ownership of the domain you scan."
    >
      <div className="grid gap-4">
        {v && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4" /> {v.domain}
            </span>
            <StateBadge {...STATE[v.state]} />
          </div>
        )}
        {v?.state === 'PENDING' && (
          <>
            <CopyField label="TXT record name" value={v.record} />
            <CopyField label="TXT record value" value={v.value} />
            <p className="text-xs text-muted-foreground">
              Add this record at your DNS provider. Studio checks every 10 minutes
              {v.lastCheckedAt
                ? ` (last check ${formatDate(v.lastCheckedAt)}: ${v.lastError ?? 'ok'})`
                : ''}
              . The request expires {formatDate(v.expiresAt)}.
            </p>
          </>
        )}
        {v?.state === 'VERIFIED' && v.verifiedAt && (
          <p className="text-sm text-muted-foreground">Verified {formatDate(v.verifiedAt)}.</p>
        )}
        {(v?.state === 'DISPUTED' || v?.state === 'PURGED') && (
          <p className="text-sm text-muted-foreground">
            You told us you don’t own this site
            {v.disputedAt ? ` (${formatDate(v.disputedAt)})` : ''}.{' '}
            {v.purgedAt
              ? `Images scraped from it were deleted ${formatDate(v.purgedAt)}; stock and generated images stay.`
              : 'Images scraped from it are being deleted (within 24 hours).'}{' '}
            Automatic rescans are off.
          </p>
        )}
        {(again || none) && <RequestForm businessId={businessId} onDone={() => void mutate()} />}
        {v?.state !== 'DISPUTED' && v?.state !== 'PURGED' && (
          <DisputeOwnership businessId={businessId} onDone={() => void mutate()} />
        )}
      </div>
    </Section>
  );
}
