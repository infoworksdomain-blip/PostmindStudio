'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ErrorState, Section } from '../primitives';
import { UsageMeters, type UsageResponse } from '../usage-meter';

// Decision P3 — staff view of one organisation's plan usage this month
// (GET /admin/organisations/:id/usage). Core owns the plan tier, so the view defaults to the tier
// recorded on the organisation's latest generation; staff can evaluate against another tier.

type Tier = UsageResponse['usage']['planTier'];

export interface AdminUsageResponse {
  usage: UsageResponse['usage'] & {
    tier: { value: Tier; source: 'query' | 'entitlements' | 'last_generation' | 'default' };
  };
}

const TIERS: readonly Tier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

function OrgUsage({ orgId, tier }: { orgId: string; tier: Tier | '' }) {
  const t = useTranslations('admin.usage');
  const tTier = useTranslations('shell.usage.tiers');
  const res = useApi<AdminUsageResponse>(
    `/admin/organisations/${encodeURIComponent(orgId)}/usage`,
    {
      tier: tier || undefined,
    },
  );
  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label={t('loadingAria')} className="h-40" />;
  const { usage } = res.data;
  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">
        {t.rich('summary', {
          month: usage.month,
          tier: tTier(usage.tier.value),
          source: t(`tierSource.${usage.tier.source}`),
          mode: t(`mode.${usage.mode}`),
          status: t(`status.${usage.status}`),
          strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
        })}
      </p>
      <UsageMeters usage={usage} />
    </div>
  );
}

export function UsagePanel() {
  const t = useTranslations('admin.usage');
  const tTier = useTranslations('shell.usage.tiers');
  const [input, setInput] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [tier, setTier] = useState<Tier | ''>('');
  return (
    <div className="grid gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOrgId(input.trim() || null);
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="usage-org">{t('orgIdLabel')}</Label>
          <Input
            id="usage-org"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('orgIdPlaceholder')}
            className="w-72"
            maxLength={128}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="usage-tier">{t('evaluateAgainst')}</Label>
          <NativeSelect
            id="usage-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as Tier | '')}
          >
            <option value="">{t('recordedTier')}</option>
            {TIERS.map((v) => (
              <option key={v} value={v}>
                {tTier(v)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline" disabled={!input.trim()}>
          {t('show')}
        </Button>
      </form>
      {orgId && (
        <Section key={orgId} title={t('title')} description={t('description')}>
          <OrgUsage orgId={orgId} tier={tier} />
        </Section>
      )}
    </div>
  );
}
