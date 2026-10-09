'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import {
  PLAN_TIERS,
  type AdminEntitlementsResponse,
  type PlanId,
  type PlanInterval,
  type PlanTier,
} from '../../billing/types';
import {
  emptyLimits,
  LimitsFieldset,
  limitsFromDraft,
  MIN_REASON,
  StudioPlanFields,
  toPence,
  useConfirmText,
  type LimitDraft,
  type LimitKey,
} from './entitlement-fields';
import {
  ACCESS,
  trialCanEnd,
  type Access,
  type EntitlementView as View,
} from './entitlements-summary';

// Phase 18 §P.3 / §P.4 — the staff entitlement override form and removing the override (split out
// of entitlements-panel.tsx in 25.13). Both need a reason (the API requires one); access none /
// read-only, ending a trial and removing the override ask for confirmation first. Every change is
// audited server side.

export function OverrideForm({
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
  const [plan, setPlan] = useState<PlanId | ''>('');
  const [billingInterval, setBillingInterval] = useState<PlanInterval | ''>('');
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
          // ENTERPRISE has no plan (custom limits instead), so none is sent with it.
          ...(!enterprise && plan && { plan }),
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
            <NativeSelect
              id="ent-tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as PlanTier | '')}
            >
              <option value="">{t('keep')}</option>
              {PLAN_TIERS.map((p) => (
                <option key={p} value={p}>
                  {tTier(p)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ent-access">{t('access')}</Label>
            <NativeSelect
              id="ent-access"
              value={access}
              onChange={(e) => setAccess(e.target.value as Access | '')}
            >
              <option value="">{t('keep')}</option>
              {ACCESS.map((a) => (
                <option key={a} value={a}>
                  {ta(`accessValues.${a}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {!enterprise && (
          <StudioPlanFields
            plan={plan}
            interval={billingInterval}
            onPlan={setPlan}
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
          <Button type="submit" disabled={!valid} loading={pending}>
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

export function ClearOverride({
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
  const [confirming, setConfirming] = useState(false);
  const valid = reason.trim().length >= MIN_REASON;
  const trialReturns = view.trial?.state === 'overridden';

  const clear = async (): Promise<boolean> => {
    setPending(true);
    try {
      const res = await api<AdminEntitlementsResponse>(path, {
        method: 'DELETE',
        body: { reason: reason.trim() },
      });
      toast.success(t('cleared'));
      setReason('');
      onCleared(res.entitlements);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (valid) setConfirming(true);
        }}
        aria-label={t('title')}
        className="grid gap-3 text-sm"
      >
        <p className="text-xs text-muted-foreground">{t('description')}</p>
        {trialReturns && (
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
          <Button type="submit" variant="destructive" disabled={!valid} loading={pending}>
            {t('button')}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle')}
        description={trialReturns ? `${t('description')} ${t('trialWarning')}` : t('description')}
        confirmLabel={t('confirmButton')}
        onConfirm={clear}
      />
    </>
  );
}
