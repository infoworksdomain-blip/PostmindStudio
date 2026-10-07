'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { CustomLimits } from '@/lib/studio/billing/entitlements';
import { ErrorState, Section } from '../../primitives';
import { selectClass } from '../../library/library-filters';
import {
  PLAN_TIERS,
  type AdminEntitlementsResponse,
  type ChannelInterval,
  type PlanTier,
} from '../../billing/types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  ACCESS,
  CHANNEL_INTERVALS,
  EntitlementsSummary,
  isChannelInterval,
  trialCanEnd,
  type Access,
  type EntitlementView as View,
} from './entitlements-summary';

// Phase 18 §P.3 / §P.4 — staff entitlement overrides for one organisation
// (GET|PUT|DELETE /admin/organisations/:id/entitlements): the effective plan, the trial, the
// stored row, the current override, subscriptions; a form to set tier, access, the channel plan
// (21.5: channels 1–6 and weekly / monthly / yearly, not for ENTERPRISE), custom limits, the
// ENTERPRISE agreed monthly price (checked live against the minimum for the organisation's
// monthly cost cap, and blocked here before the server's 422), an optional expiry, "End the trial
// now" (20.27) and a required reason; and removing the override (reason required). Access
// none / read-only and ending a trial ask for confirmation first. Every change is audited server
// side.

const LIMIT_KEYS = [
  'seats',
  'businesses',
  'storageGb',
  'shortVideos',
  'longVideos',
  'longMaxSec',
  'generatedImagesPerBusinessPerMonth',
  'scanBusinesses',
] as const satisfies readonly (keyof CustomLimits)[];
type LimitKey = (typeof LIMIT_KEYS)[number];
/** generatedImagesPerBusinessPerMonth cannot be unlimited (the schema has no null for it). */
const NO_UNLIMITED: ReadonlySet<LimitKey> = new Set(['generatedImagesPerBusinessPerMonth']);
const MIN_REASON = 3;
/** 21.5: the channel plan's range (MIN_CHANNELS / MAX_CHANNELS in billing/channel-plan.ts). */
const CHANNEL_COUNTS = [1, 2, 3, 4, 5, 6] as const;

interface LimitDraft {
  value: string;
  unlimited: boolean;
}

const emptyLimits = (): Record<LimitKey, LimitDraft> =>
  Object.fromEntries(LIMIT_KEYS.map((k) => [k, { value: '', unlimited: false }])) as Record<
    LimitKey,
    LimitDraft
  >;

/** The limits object for the PUT body, or undefined when nothing is set. */
export function limitsFromDraft(draft: Record<LimitKey, LimitDraft>): CustomLimits | undefined {
  const entries = LIMIT_KEYS.flatMap((key): [LimitKey, number | null][] => {
    const d = draft[key];
    if (d.unlimited && !NO_UNLIMITED.has(key)) return [[key, null]];
    if (d.value.trim() === '') return [];
    return [[key, Math.max(0, Math.round(Number(d.value)))]];
  });
  return entries.length ? (Object.fromEntries(entries) as CustomLimits) : undefined;
}

const toPence = (pounds: string): number | null =>
  pounds.trim() === '' || Number.isNaN(Number(pounds)) ? null : Math.round(Number(pounds) * 100);

function LimitsFieldset({
  limits,
  onChange,
}: {
  limits: Record<LimitKey, LimitDraft>;
  onChange: (key: LimitKey, patch: Partial<LimitDraft>) => void;
}) {
  const t = useTranslations('billing.admin.entitlements.form');
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium">{t('limits')}</legend>
      <p className="text-xs text-muted-foreground">{t('limitsHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_KEYS.map((key) => {
          const label = t(`limitLabels.${key}`);
          const d = limits[key];
          return (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`ent-limit-${key}`}>{label}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id={`ent-limit-${key}`}
                  type="number"
                  min={0}
                  step={1}
                  className="max-w-32"
                  value={d.value}
                  disabled={d.unlimited}
                  onChange={(e) => onChange(key, { value: e.target.value })}
                />
                {!NO_UNLIMITED.has(key) && (
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={d.unlimited}
                      aria-label={t('unlimitedAria', { limit: label })}
                      onChange={(e) => onChange(key, { unlimited: e.target.checked })}
                    />
                    {t('unlimited')}
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 21.5: the channel count (1–6) and billing interval staff give the organisation. */
function ChannelPlanFields({
  channels,
  interval,
  onChannels,
  onInterval,
}: {
  channels: string;
  interval: ChannelInterval | '';
  onChannels: (value: string) => void;
  onInterval: (value: ChannelInterval | '') => void;
}) {
  const t = useTranslations('billing.admin.entitlements.form');
  const ta = useTranslations('billing.admin.entitlements');
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium">{t('channelPlan')}</legend>
      <p id="ent-channel-plan-help" className="text-xs text-muted-foreground">
        {t('channelPlanHelp')}
      </p>
      <div className="flex flex-wrap gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="ent-channels">{t('channels')}</Label>
          <select
            id="ent-channels"
            className={selectClass}
            value={channels}
            aria-describedby="ent-channel-plan-help"
            onChange={(e) => onChannels(e.target.value)}
          >
            <option value="">{t('keep')}</option>
            {CHANNEL_COUNTS.map((n) => (
              <option key={n} value={String(n)}>
                {t('channelsOption', { count: n })}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ent-interval">{t('interval')}</Label>
          <select
            id="ent-interval"
            className={selectClass}
            value={interval}
            aria-describedby="ent-channel-plan-help"
            onChange={(e) => onInterval(isChannelInterval(e.target.value) ? e.target.value : '')}
          >
            <option value="">{t('keep')}</option>
            {CHANNEL_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {ta(`intervalValues.${i}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </fieldset>
  );
}

/** What the confirmation says, or null when the change needs none. */
function useConfirmText(): (access: Access | '', endTrial: boolean) => string | null {
  const t = useTranslations('billing.admin.entitlements.confirm');
  return (access, endTrial) => {
    const lines = [
      access === 'none' ? t('accessNone') : null,
      access === 'read_only' ? t('accessReadOnly') : null,
      endTrial ? t('endTrial') : null,
    ].filter((l): l is string => l !== null);
    return lines.length ? lines.join(' ') : null;
  };
}

function OverrideForm({
  view,
  path,
  onSaved,
}: {
  view: View;
  path: string;
  onSaved: (v: View) => void;
}) {
  const t = useTranslations('billing.admin.entitlements.form');
  const ta = useTranslations('billing.admin.entitlements');
  const tc = useTranslations('billing.admin.entitlements.confirm');
  const tTier = useTranslations('shell.usage.tiers');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const confirmText = useConfirmText();
  const [tier, setTier] = useState<PlanTier | ''>('');
  const [access, setAccess] = useState<Access | ''>('');
  const [channels, setChannels] = useState('');
  const [billingInterval, setBillingInterval] = useState<ChannelInterval | ''>('');
  const [limits, setLimits] = useState(emptyLimits);
  const [price, setPrice] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [endTrial, setEndTrial] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const effectiveTier = tier || view.effective.tier;
  const enterprise = effectiveTier === 'ENTERPRISE';
  const minimum = view.enterprise.minimumMonthlyPricePence;
  const pricePence = toPence(price);
  const priceProblem = !enterprise
    ? null
    : pricePence === null
      ? t('priceRequired')
      : pricePence < minimum
        ? t('belowMinimum', { amount: f.pence(minimum) })
        : null;
  const valid = reason.trim().length >= MIN_REASON && priceProblem === null;
  const canEndTrial = trialCanEnd(view);

  const save = async (): Promise<boolean> => {
    const limitsBody = limitsFromDraft(limits);
    setPending(true);
    try {
      const res = await api<AdminEntitlementsResponse>(path, {
        method: 'PUT',
        body: {
          ...(tier && { tier }),
          ...(access && { access }),
          // ENTERPRISE has no channel plan (custom limits instead), so none is sent with it.
          ...(!enterprise && channels && { channels: Number(channels) }),
          ...(!enterprise && billingInterval && { interval: billingInterval }),
          ...(limitsBody && { limits: limitsBody }),
          ...(enterprise && { monthlyPricePence: pricePence }),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          ...(canEndTrial && endTrial && { endTrial: true }),
          reason: reason.trim(),
        },
      });
      toast.success(t('saved'));
      setReason('');
      setEndTrial(false);
      onSaved(res.entitlements);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const text = confirmText(access, canEndTrial && endTrial);
    if (text) setConfirming(text);
    else void save();
  };

  const setLimit = (key: LimitKey, patch: Partial<LimitDraft>) =>
    setLimits((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  return (
    <>
      <form onSubmit={submit} aria-label={t('title')} className="grid gap-4 text-sm">
        <div className="flex flex-wrap gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ent-tier">{t('tier')}</Label>
            <select
              id="ent-tier"
              className={selectClass}
              value={tier}
              onChange={(e) => setTier(e.target.value as PlanTier | '')}
            >
              <option value="">{t('keep')}</option>
              {PLAN_TIERS.map((p) => (
                <option key={p} value={p}>
                  {tTier(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ent-access">{t('access')}</Label>
            <select
              id="ent-access"
              className={selectClass}
              value={access}
              onChange={(e) => setAccess(e.target.value as Access | '')}
            >
              <option value="">{t('keep')}</option>
              {ACCESS.map((a) => (
                <option key={a} value={a}>
                  {ta(`accessValues.${a}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!enterprise && (
          <ChannelPlanFields
            channels={channels}
            interval={billingInterval}
            onChannels={setChannels}
            onInterval={setBillingInterval}
          />
        )}
        {canEndTrial && view.trial && (
          <div className="grid gap-1.5 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={endTrial}
                onChange={(e) => setEndTrial(e.target.checked)}
                aria-describedby="ent-end-trial-help"
              />
              {t('endTrial')}
            </label>
            <p id="ent-end-trial-help" className="text-xs text-muted-foreground">
              {t('endTrialHelp', {
                daily: f.pence(view.trial.dailyCostCapPence),
                total: f.pence(view.trial.totalCostCapPence),
              })}
            </p>
            {view.trial.state === 'running' && (
              <p className="text-xs text-muted-foreground">{t('trialNote')}</p>
            )}
          </div>
        )}
        <LimitsFieldset limits={limits} onChange={setLimit} />
        {enterprise && (
          <div className="grid gap-1.5">
            <Label htmlFor="ent-price">{t('price')}</Label>
            <Input
              id="ent-price"
              type="number"
              min={0}
              step={0.01}
              className="max-w-40"
              value={price}
              aria-invalid={priceProblem !== null && price !== ''}
              aria-describedby="ent-price-help"
              onChange={(e) => setPrice(e.target.value)}
            />
            <p id="ent-price-help" className="text-xs text-muted-foreground">
              {t('minimum', {
                cap: f.pence(view.enterprise.monthlyCapPence),
                amount: f.pence(minimum),
              })}
            </p>
            {priceProblem && (
              <p role="alert" className="text-xs text-destructive">
                {priceProblem}
              </p>
            )}
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="ent-expires">{t('expiresAt')}</Label>
          <Input
            id="ent-expires"
            type="datetime-local"
            className="max-w-60"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ent-reason">{t('reason')}</Label>
          <Textarea
            id="ent-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" disabled={pending || !valid}>
            {pending && <Loader2 className="animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={tc('title')}
        description={confirming ?? ''}
        confirmLabel={tc('button')}
        onConfirm={save}
      />
    </>
  );
}

function ClearOverride({
  view,
  path,
  onCleared,
}: {
  view: View;
  path: string;
  onCleared: (v: View) => void;
}) {
  const t = useTranslations('billing.admin.entitlements.clear');
  const errorMessage = useErrorMessage();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const clear = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const res = await api<AdminEntitlementsResponse>(path, {
        method: 'DELETE',
        body: { reason: reason.trim() },
      });
      toast.success(t('cleared'));
      setReason('');
      onCleared(res.entitlements);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={clear} aria-label={t('title')} className="grid gap-3 text-sm">
      <p className="text-xs text-muted-foreground">{t('description')}</p>
      {view.trial?.state === 'overridden' && (
        <p role="note" className="text-xs text-warning-foreground">
          {t('trialWarning')}
        </p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="ent-clear-reason">{t('reason')}</Label>
        <Input
          id="ent-clear-reason"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div>
        <Button
          type="submit"
          variant="destructive"
          disabled={pending || reason.trim().length < MIN_REASON}
        >
          {pending && <Loader2 className="animate-spin" />}
          {t('button')}
        </Button>
      </div>
    </form>
  );
}

function useEntitlements(orgId: string) {
  const path = `/admin/organisations/${encodeURIComponent(orgId)}/entitlements`;
  const res = useApi<AdminEntitlementsResponse>(path);
  const update = (next: View) => void res.mutate({ entitlements: next }, { revalidate: false });
  return { path, res, update };
}

/** Remount the form after every save so its fields start empty again. */
const formKey = (view: View) => `${view.admin?.setAt ?? 'none'}:${view.trial?.endedAt ?? ''}`;

/** One organisation's plan: the summary, the override form and removing the override. */
export function EntitlementsDetail({ orgId }: { orgId: string }) {
  const t = useTranslations('billing.admin.entitlements');
  const { path, res, update } = useEntitlements(orgId);
  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label={t('loading')} className="h-48" />;
  const view = res.data.entitlements;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <Section title={t('effective')}>
        <EntitlementsSummary view={view} />
      </Section>
      <div className="grid min-w-0 gap-6">
        <Section title={t('form.title')}>
          <OverrideForm key={formKey(view)} view={view} path={path} onSaved={update} />
        </Section>
        {view.admin && (
          <Section title={t('clear.title')}>
            <ClearOverride view={view} path={path} onCleared={update} />
          </Section>
        )}
      </div>
    </div>
  );
}

/**
 * 20.27: the organisation page's "Plan, access and trial" section, one card beside Cost caps
 * (same Section pattern): the plan and trial, the override form, and removing the override.
 */
export function PlanOverrideSection({ orgId }: { orgId: string }) {
  const t = useTranslations('billing.admin.entitlements');
  const tOrg = useTranslations('adminOrgs.detail');
  const { path, res, update } = useEntitlements(orgId);
  const view = res.data?.entitlements;
  return (
    <Section title={tOrg('planTitle')} description={tOrg('planHint')}>
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !view ? (
        <Skeleton aria-label={t('loading')} className="h-48" />
      ) : (
        <div className="grid min-w-0 gap-6">
          <EntitlementsSummary view={view} />
          <div className="grid gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">{t('form.title')}</h3>
            <OverrideForm key={formKey(view)} view={view} path={path} onSaved={update} />
          </div>
          {view.admin && (
            <div className="grid gap-3 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">{t('clear.title')}</h3>
              <ClearOverride view={view} path={path} onCleared={update} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

export function EntitlementsPanel() {
  const t = useTranslations('billing.admin.entitlements');
  const [input, setInput] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOrgId(input.trim() || null);
        }}
      >
        <div className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor="ent-org-lookup">{t('orgIdLabel')}</Label>
          <Input
            id="ent-org-lookup"
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
      {orgId && <EntitlementsDetail key={orgId} orgId={orgId} />}
    </div>
  );
}
