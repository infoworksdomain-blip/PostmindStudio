'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, Globe, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat, type Tone } from '@/lib/client/format';
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

const STATE_TONE: Record<DomainState, Tone> = {
  PENDING: 'live',
  VERIFIED: 'good',
  EXPIRED: 'neutral',
  DISPUTED: 'bad',
  PURGED: 'bad',
};

function CopyField({
  label,
  copyLabel,
  value,
}: {
  label: string;
  copyLabel: string;
  value: string;
}) {
  const t = useTranslations('business.domain');
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm">{value}</code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={copyLabel}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(value)
              .then(() => toast.success(t('copied')))
              .catch(() => toast.error(t('copyFailed')))
          }
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

function RequestForm({ businessId, onDone }: { businessId: string; onDone: () => void }) {
  const t = useTranslations('business.domain');
  const errorMessage = useErrorMessage();
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
          // The only 403 here is the Enterprise plan gate.
          if (err instanceof ApiError && err.status === 403) setRefused(t('enterpriseOnly'));
          else toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Label htmlFor="verify-domain">{t('domainLabel')}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="verify-domain"
          placeholder={t('domainPlaceholder')}
          value={domain}
          maxLength={253}
          onChange={(e) => setDomain(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!domain.trim() || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Globe />} {t('verify')}
        </Button>
      </div>
      {refused && (
        <p role="alert" className="text-sm text-muted-foreground">
          {refused}
        </p>
      )}
    </form>
  );
}

export function DomainVerificationCard({ businessId }: { businessId: string }) {
  const t = useTranslations('business.domain');
  const f = useFormat();
  const path = `/businesses/${encodeURIComponent(businessId)}/domain-verification`;
  const { data, error, mutate } = useApi<{ verification: DomainVerification }>(path, undefined, {
    shouldRetryOnError: false,
    refreshInterval: (latest) => (latest?.verification?.state === 'PENDING' ? 60_000 : 0),
  });
  const v = data?.verification;
  const none = error instanceof ApiError && error.status === 404;
  const again = !v || v.state === 'EXPIRED';

  return (
    <Section title={t('title')} description={t('description')}>
      <div className="grid gap-4">
        {v && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4" /> {v.domain}
            </span>
            <StateBadge label={t(`states.${v.state}`)} tone={STATE_TONE[v.state]} />
          </div>
        )}
        {v?.state === 'PENDING' && (
          <>
            <CopyField label={t('recordName')} copyLabel={t('copyRecordName')} value={v.record} />
            <CopyField label={t('recordValue')} copyLabel={t('copyRecordValue')} value={v.value} />
            <p className="text-xs text-muted-foreground">
              {v.lastCheckedAt
                ? t('pendingHelpChecked', {
                    checked: f.date(v.lastCheckedAt),
                    result: v.lastError ?? t('checkOk'),
                    expires: f.date(v.expiresAt),
                  })
                : t('pendingHelp', { expires: f.date(v.expiresAt) })}
            </p>
          </>
        )}
        {v?.state === 'VERIFIED' && v.verifiedAt && (
          <p className="text-sm text-muted-foreground">
            {t('verifiedOn', { date: f.date(v.verifiedAt) })}
          </p>
        )}
        {(v?.state === 'DISPUTED' || v?.state === 'PURGED') && (
          <p className="text-sm text-muted-foreground">
            {v.disputedAt ? t('disputedOn', { date: f.date(v.disputedAt) }) : t('disputed')}{' '}
            {v.purgedAt ? t('purgedOn', { date: f.date(v.purgedAt) }) : t('purging')}{' '}
            {t('rescansOff')}
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
