'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { UsageMeters, type UsageResponse } from '../usage-meter';

// Decision P3 — staff view of one organisation's plan usage this month
// (GET /admin/organisations/:id/usage). Core owns the plan tier, so the view defaults to the tier
// recorded on the organisation's latest generation; staff can evaluate against another tier.

type Tier = UsageResponse['usage']['planTier'];

export interface AdminUsageResponse {
  usage: UsageResponse['usage'] & {
    tier: { value: Tier; source: 'query' | 'last_generation' | 'default' };
  };
}

const TIER_SOURCE: Record<AdminUsageResponse['usage']['tier']['source'], string> = {
  query: 'chosen here',
  last_generation: 'recorded on its latest generation',
  default: 'no generation recorded — Basic assumed',
};

function OrgUsage({ orgId, tier }: { orgId: string; tier: Tier | '' }) {
  const res = useApi<AdminUsageResponse>(
    `/admin/organisations/${encodeURIComponent(orgId)}/usage`,
    {
      tier: tier || undefined,
    },
  );
  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label="Loading usage" className="h-40" />;
  const { usage } = res.data;
  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">
        {usage.month} · tier {usage.tier.value} ({TIER_SOURCE[usage.tier.source]}) · quota mode{' '}
        <span className="font-medium text-foreground">{usage.mode}</span> · status{' '}
        <span className="font-medium text-foreground">{usage.status}</span>
      </p>
      <UsageMeters usage={usage} />
    </div>
  );
}

export function UsagePanel() {
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
          <Label htmlFor="usage-org">Organisation id</Label>
          <Input
            id="usage-org"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="org_…"
            className="w-72"
            maxLength={128}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="usage-tier">Evaluate against</Label>
          <select
            id="usage-tier"
            className={selectClass}
            value={tier}
            onChange={(e) => setTier(e.target.value as Tier | '')}
          >
            <option value="">Recorded tier</option>
            <option value="BASIC">Basic</option>
            <option value="STANDARD">Standard</option>
            <option value="PLUS">Plus</option>
            <option value="ENTERPRISE">Enterprise</option>
          </select>
        </div>
        <Button type="submit" variant="outline" disabled={!input.trim()}>
          Show usage
        </Button>
      </form>
      {orgId && (
        <Section
          key={orgId}
          title="Plan usage this month"
          description="Videos generated this calendar month (UTC) against the spec 12.4 quotas."
        >
          <OrgUsage orgId={orgId} tier={tier} />
        </Section>
      )}
    </div>
  );
}
