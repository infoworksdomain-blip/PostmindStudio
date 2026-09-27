'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { formatPence, relativeTime } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';

// BACKLOG 13.18 / 13.19 — one organisation's review policy (GET|PUT
// /admin/organisations/:id/policy) and cost cap overrides (GET|PUT …/cost-caps). Studio does not
// list organisations (Core owns them), so staff look one up by id — the cost report and the
// safety queue show ids.

type ReviewPolicy = 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'REQUIRE_APPROVAL_FROM_ROLE';

export interface OrgPolicyResponse {
  organisationId: string;
  policy: {
    defaultReviewPolicy: ReviewPolicy;
    autoApproveTrustThreshold: number | null;
    autoApproveAllowed: boolean;
  };
  source: Record<
    'defaultReviewPolicy' | 'autoApproveTrustThreshold' | 'autoApproveAllowed',
    string
  >;
  updatedAt: string | null;
}

type TierCaps = Record<string, { pence: number | null; source: string }>;

export interface OrgCostCapsResponse {
  organisationId: string;
  caps: {
    daily: { pence: number | null; source: 'org_override' | 'plan_tier'; byTier: TierCaps };
    monthly: { pence: number | null; source: 'org_override' | 'plan_tier'; byTier: TierCaps };
  };
  override: {
    dailyPence: number | null;
    monthlyPence: number | null;
    reason: string;
    updatedByUserId: string;
    updatedAt: string;
  } | null;
}

const POLICY_LABEL: Record<ReviewPolicy, string> = {
  REQUIRE_APPROVAL: 'Require approval',
  REQUIRE_APPROVAL_FROM_ROLE: 'Require approval from an owner or admin',
  AUTO_APPROVE: 'Auto-approve trusted creators',
};

function PolicyForm({ orgId }: { orgId: string }) {
  const res = useApi<OrgPolicyResponse>(`/admin/organisations/${encodeURIComponent(orgId)}/policy`);
  const [draft, setDraft] = useState<OrgPolicyResponse['policy'] | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => setDraft(res.data?.policy ?? null), [res.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setPending(true);
    try {
      await api(`/admin/organisations/${encodeURIComponent(orgId)}/policy`, {
        method: 'PUT',
        body: {
          defaultReviewPolicy: draft.defaultReviewPolicy,
          autoApproveAllowed: draft.autoApproveAllowed,
          autoApproveTrustThreshold: draft.autoApproveTrustThreshold,
        },
      });
      toast.success('Policy saved');
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data || !draft) return <Skeleton aria-label="Loading policy" className="h-40" />;
  return (
    <form onSubmit={save} aria-label="Review policy" className="grid gap-4 text-sm">
      <div className="grid gap-1.5">
        <Label htmlFor="org-default-policy">Default review policy for new projects</Label>
        <select
          id="org-default-policy"
          className={selectClass}
          value={draft.defaultReviewPolicy}
          onChange={(e) =>
            setDraft({ ...draft, defaultReviewPolicy: e.target.value as ReviewPolicy })
          }
        >
          {(Object.keys(POLICY_LABEL) as ReviewPolicy[]).map((p) => (
            <option key={p} value={p}>
              {POLICY_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <Switch
          id="org-auto-approve"
          checked={draft.autoApproveAllowed}
          onCheckedChange={(checked) => setDraft({ ...draft, autoApproveAllowed: checked })}
        />
        <Label htmlFor="org-auto-approve">Allow automatic approval</Label>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="org-threshold">
          Trust threshold (videos approved by a person before auto-approval)
        </Label>
        <Input
          id="org-threshold"
          type="number"
          min={1}
          max={1000}
          className="max-w-32"
          value={draft.autoApproveTrustThreshold ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              autoApproveTrustThreshold: e.target.value ? Number(e.target.value) : null,
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Empty = the platform setting. Currently from: {res.data.source.autoApproveTrustThreshold}.
          Enterprise plans are never auto-approved.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Save policy
        </Button>
        {res.data.updatedAt && (
          <span className="text-xs text-muted-foreground">
            Last changed {relativeTime(res.data.updatedAt)}
          </span>
        )}
      </div>
    </form>
  );
}

const toPence = (pounds: string): number | null =>
  pounds.trim() === '' ? null : Math.round(Number(pounds) * 100);
const toPounds = (pence: number | null | undefined) =>
  pence === null || pence === undefined ? '' : String(pence / 100);

function CapLine({ label, cap }: { label: string; cap: OrgCostCapsResponse['caps']['daily'] }) {
  return (
    <p>
      <span className="text-muted-foreground">{label}: </span>
      {cap.source === 'org_override' ? (
        <>
          {formatPence(cap.pence)}{' '}
          <span className="rounded bg-primary/10 px-1 text-[10px] uppercase text-primary">
            org override
          </span>
        </>
      ) : (
        <>
          plan tier —{' '}
          {Object.entries(cap.byTier)
            .map(
              ([tier, c]) =>
                `${tier.toLowerCase()} ${c.pence === null ? 'no cap' : formatPence(c.pence)}`,
            )
            .join(' · ')}
        </>
      )}
    </p>
  );
}

function CostCapsForm({ orgId }: { orgId: string }) {
  const path = `/admin/organisations/${encodeURIComponent(orgId)}/cost-caps`;
  const res = useApi<OrgCostCapsResponse>(path);
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setDaily(toPounds(res.data?.override?.dailyPence));
    setMonthly(toPounds(res.data?.override?.monthlyPence));
  }, [res.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await api(path, {
        method: 'PUT',
        body: { dailyPence: toPence(daily), monthlyPence: toPence(monthly), reason: reason.trim() },
      });
      toast.success('Cost caps saved');
      setReason('');
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label="Loading cost caps" className="h-40" />;
  return (
    <form onSubmit={save} aria-label="Cost cap overrides" className="grid gap-4 text-sm">
      <div className="grid gap-1">
        <CapLine label="Daily" cap={res.data.caps.daily} />
        <CapLine label="Monthly" cap={res.data.caps.monthly} />
        {res.data.override && (
          <p className="text-xs text-muted-foreground">
            “{res.data.override.reason}” — {relativeTime(res.data.override.updatedAt)}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="cap-daily">Daily cap override (£)</Label>
          <Input
            id="cap-daily"
            type="number"
            min={0.01}
            step={0.01}
            className="max-w-40"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cap-monthly">Monthly cap override (£)</Label>
          <Input
            id="cap-monthly"
            type="number"
            min={0.01}
            step={0.01}
            className="max-w-40"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Empty = no override (the plan tier’s cap). Workers apply a change within 30 seconds.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="cap-reason">Reason (recorded in the audit log)</Label>
        <Textarea
          id="cap-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" disabled={pending || reason.trim().length < 3}>
          {pending && <Loader2 className="animate-spin" />}
          Save cost caps
        </Button>
      </div>
    </form>
  );
}

export function OrganisationPanel() {
  const [input, setInput] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
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
          <Label htmlFor="org-lookup">Organisation id</Label>
          <Input
            id="org-lookup"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="org_…"
            className="w-72"
            maxLength={128}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!input.trim()}>
          Open
        </Button>
      </form>
      {orgId && (
        <div className="grid gap-6 lg:grid-cols-2" key={orgId}>
          <Section
            title="Review policy"
            description="Applies to new projects and to automatic approval in this organisation."
          >
            <PolicyForm orgId={orgId} />
          </Section>
          <Section
            title="Cost caps"
            description="Overrides the plan tier’s daily and monthly caps for this organisation only."
          >
            <CostCapsForm orgId={orgId} />
          </Section>
        </div>
      )}
    </div>
  );
}
