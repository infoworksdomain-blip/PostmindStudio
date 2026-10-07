'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';

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

const POLICIES: readonly ReviewPolicy[] = [
  'REQUIRE_APPROVAL',
  'REQUIRE_APPROVAL_FROM_ROLE',
  'AUTO_APPROVE',
];

const PLAN_TIERS = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const;
type PlanTier = (typeof PLAN_TIERS)[number];
const isPlanTier = (tier: string): tier is PlanTier =>
  (PLAN_TIERS as readonly string[]).includes(tier);

function PolicyForm({ orgId }: { orgId: string }) {
  const t = useTranslations('admin.organisations.policy');
  const f = useFormat();
  const errorMessage = useErrorMessage();
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
      toast.success(t('savedToast'));
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data || !draft) return <Skeleton aria-label={t('loadingAria')} className="h-40" />;
  return (
    <form onSubmit={save} aria-label={t('formAria')} className="grid gap-4 text-sm">
      <div className="grid gap-1.5">
        <Label htmlFor="org-default-policy">{t('defaultLabel')}</Label>
        <NativeSelect
          id="org-default-policy"
          value={draft.defaultReviewPolicy}
          onChange={(e) =>
            setDraft({ ...draft, defaultReviewPolicy: e.target.value as ReviewPolicy })
          }
        >
          {POLICIES.map((p) => (
            <option key={p} value={p}>
              {t(`option.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex items-center gap-3">
        <Switch
          id="org-auto-approve"
          checked={draft.autoApproveAllowed}
          onCheckedChange={(checked) => setDraft({ ...draft, autoApproveAllowed: checked })}
        />
        <Label htmlFor="org-auto-approve">{t('autoApprove')}</Label>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="org-threshold">{t('threshold')}</Label>
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
          {t('thresholdHelp', { source: res.data.source.autoApproveTrustThreshold })}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          {t('save')}
        </Button>
        {res.data.updatedAt && (
          <span className="text-xs text-muted-foreground">
            {t('lastChanged', { when: f.relative(res.data.updatedAt) })}
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
  const t = useTranslations('admin.organisations.caps');
  const tTier = useTranslations('shell.usage.tiers');
  const f = useFormat();
  const tiers = Object.entries(cap.byTier)
    .map(([tier, c]) =>
      t('tierCap', {
        tier: isPlanTier(tier) ? tTier(tier) : tier,
        amount: c.pence === null ? t('noCap') : f.pence(c.pence),
      }),
    )
    .join(' · ');
  return (
    <p>
      <span className="text-muted-foreground">{label}</span>{' '}
      {cap.source === 'org_override' ? (
        <>
          {f.pence(cap.pence)}{' '}
          <StatusPill tone="info" size="sm">
            {t('orgOverride')}
          </StatusPill>
        </>
      ) : (
        t('planTier', { tiers })
      )}
    </p>
  );
}

function CostCapsForm({ orgId }: { orgId: string }) {
  const t = useTranslations('admin.organisations.caps');
  const f = useFormat();
  const errorMessage = useErrorMessage();
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

  const put = async (dailyPence: number | null, monthlyPence: number | null, done: string) => {
    setPending(true);
    try {
      await api(path, {
        method: 'PUT',
        body: { dailyPence, monthlyPence, reason: reason.trim() },
      });
      toast.success(done);
      setReason('');
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void put(toPence(daily), toPence(monthly), t('savedToast'));
  };
  // 20.27: both overrides removed in one audited PUT (null clears a value).
  const clear = () => void put(null, null, t('clearedToast'));
  const reasonOk = reason.trim().length >= 3;

  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label={t('loadingAria')} className="h-40" />;
  const own = res.data.override;
  const hasOverride = Boolean(own && (own.dailyPence !== null || own.monthlyPence !== null));
  return (
    <form onSubmit={save} aria-label={t('formAria')} className="grid gap-4 text-sm">
      <div className="grid gap-1">
        <CapLine label={t('daily')} cap={res.data.caps.daily} />
        <CapLine label={t('monthly')} cap={res.data.caps.monthly} />
        {res.data.override && (
          <p className="text-xs text-muted-foreground">
            {t('overrideReason', {
              reason: res.data.override.reason,
              when: f.relative(res.data.override.updatedAt),
            })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="cap-daily">{t('dailyOverride')}</Label>
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
          <Label htmlFor="cap-monthly">{t('monthlyOverride')}</Label>
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
      <p className="text-xs text-muted-foreground">{t('overrideHelp')}</p>
      <div className="grid gap-1.5">
        <Label htmlFor="cap-reason">{t('reason')}</Label>
        <Textarea
          id="cap-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!reasonOk} loading={pending}>
          {t('save')}
        </Button>
        {hasOverride && (
          <Button
            type="button"
            variant="outline"
            disabled={pending || !reasonOk}
            onClick={clear}
            aria-describedby="cap-clear-help"
          >
            {t('clear')}
          </Button>
        )}
      </div>
      {hasOverride && (
        <p id="cap-clear-help" className="text-xs text-muted-foreground">
          {t('clearHelp')}
        </p>
      )}
    </form>
  );
}

/** 13.18: one organisation's review policy. */
export function PolicySection({ orgId }: { orgId: string }) {
  const t = useTranslations('admin.organisations');
  return (
    <Section title={t('policy.title')} description={t('policy.description')}>
      <PolicyForm orgId={orgId} />
    </Section>
  );
}

/** 13.19: one organisation's cost cap overrides. */
export function CostCapsSection({ orgId }: { orgId: string }) {
  const t = useTranslations('admin.organisations');
  return (
    <Section title={t('caps.title')} description={t('caps.description')}>
      <CostCapsForm orgId={orgId} />
    </Section>
  );
}

/** 13.18 / 13.19: one organisation's review policy and cost caps, side by side. */
export function OrganisationSettings({ orgId }: { orgId: string }) {
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <PolicySection orgId={orgId} />
      <CostCapsSection orgId={orgId} />
    </div>
  );
}

/** Phase 18: the Organisations directory opens a chosen organisation here (initialOrgId). */
export function OrganisationPanel({ initialOrgId }: { initialOrgId?: string } = {}) {
  const t = useTranslations('admin.organisations');
  const [input, setInput] = useState(initialOrgId ?? '');
  const [orgId, setOrgId] = useState<string | null>(initialOrgId ?? null);
  return (
    <div className="grid gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOrgId(input.trim() || null);
        }}
      >
        <div className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor="org-lookup">{t('orgIdLabel')}</Label>
          <Input
            id="org-lookup"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('orgIdPlaceholder')}
            className="w-full sm:w-72"
            maxLength={128}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!input.trim()}>
          {t('open')}
        </Button>
      </form>
      {orgId && <OrganisationSettings key={orgId} orgId={orgId} />}
    </div>
  );
}
