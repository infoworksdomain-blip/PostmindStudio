'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { StudioCapability } from '@/lib/rbac';
import type { BusinessesResponse } from '../business-picker';
import { WriteGate } from '../write-gate';

// Rename a business and set its website address (PATCH /businesses/:id, Phase 18 §2.11). Until
// now a typo in the name typed when the business was added could not be fixed anywhere. Shown
// only where Studio owns the business list (standalone); in core mode businesses live in PostMind.

// Mirrors services/businesses.ts: a bare host name, stored lower-case without scheme or slashes.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The host name the server would store for what was typed, or null when it is not one. */
export function normaliseDomain(typed: string): string | null {
  const host = typed
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return HOSTNAME.test(host) ? host : null;
}

function DetailsForm({
  business,
  onSaved,
}: {
  business: { id: string; name: string; domain?: string };
  onSaved: () => void;
}) {
  const t = useTranslations('business.details');
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(business.name);
  const [domain, setDomain] = useState(business.domain ?? '');
  const [saving, setSaving] = useState(false);
  const typedDomain = domain.trim();
  const host = typedDomain ? normaliseDomain(typedDomain) : null;
  const domainInvalid = typedDomain !== '' && host === null;
  const dirty = name.trim() !== business.name || (host ?? '') !== (business.domain ?? '');
  const valid = name.trim() !== '' && !domainInvalid;

  async function save() {
    setSaving(true);
    try {
      await api(`/businesses/${encodeURIComponent(business.id)}`, {
        method: 'PATCH',
        body: { name: name.trim(), domain: host },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('saved'));
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid) void save();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="business-details-name">{t('name')}</Label>
        <Input
          id="business-details-name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="business-details-domain">{t('domain')}</Label>
        <Input
          id="business-details-domain"
          inputMode="url"
          dir="ltr"
          value={domain}
          aria-invalid={domainInvalid || undefined}
          aria-describedby="business-details-domain-hint"
          onChange={(e) => setDomain(e.target.value)}
        />
        <p
          id="business-details-domain-hint"
          className={domainInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {domainInvalid ? t('domainInvalid') : t('domainHint')}
        </p>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={!dirty || !valid || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {t('save')}
        </Button>
      </div>
    </form>
  );
}

export function BusinessDetailsCard({ businessId }: { businessId: string }) {
  const t = useTranslations('business.details');
  const { data, mutate } = useApi<BusinessesResponse>('/businesses', undefined, {
    shouldRetryOnError: false,
  });
  const business = data?.data.find((b) => b.id === businessId);
  if (!data?.local || !business) return null;
  return (
    <section aria-labelledby="business-details-title" className="mb-8 grid gap-4">
      <div>
        <h2 id="business-details-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <WriteGate capability={StudioCapability.BusinessManage}>
        <DetailsForm
          key={`${business.id}|${business.name}|${business.domain ?? ''}`}
          business={business}
          onSaved={() => void mutate()}
        />
      </WriteGate>
    </section>
  );
}
