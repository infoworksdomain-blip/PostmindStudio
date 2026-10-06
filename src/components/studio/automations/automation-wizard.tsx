'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, Leaf, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { useShowCosts } from '../account/use-show-costs';
import { buildTargets, connectionsFor } from '../automation/automation';
import { useBusiness } from '../business-context';
import { PlatformChips } from '../create/create-options';
import { defaultPlatforms } from '../create/formats';
import { EmptyState, PageHeader } from '../primitives';
import { Field } from '../review/field';
import type { FormatKey } from '../blitz/blitz-model';
import {
  DURATIONS,
  type AutomationEstimate,
  type AutomationSummary,
  type Cadence,
  type Duration,
} from './automation-model';

// 22.5 — /automations/new: channels → cadence → mix → approval → summary. The summary shows how
// many posts a period makes and the format split (cheapest first); customers never see pence —
// staff get the typical provider cost (useShowCosts). Create makes a DRAFT and starts it.

const STEPS = ['channels', 'cadence', 'mix', 'approval', 'summary'] as const;
type Step = (typeof STEPS)[number];

interface WizardState {
  name: string;
  platforms: string[];
  cadence: Cadence;
  duration: Duration;
  approvalMode: 'review' | 'auto';
}

function defaultZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  } catch {
    return 'Europe/London';
  }
}

export function AutomationWizard() {
  const t = useTranslations('automations');
  const tb = useTranslations('blitz.deck');
  const f = useFormat();
  const router = useRouter();
  const errorText = useErrorMessage();
  const showCosts = useShowCosts();
  const { businessId, ready } = useBusiness();
  const connections = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const [step, setStep] = useState<Step>('channels');
  const [state, setState] = useState<WizardState | null>(null);
  const [estimate, setEstimate] = useState<AutomationEstimate | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state || !connections.data) return;
    setState({
      name: '',
      platforms: defaultPlatforms(connections.data.data, businessId),
      cadence: { mode: 'per_day', postsPerDay: 1 },
      duration: 'ongoing_weekly',
      approvalMode: 'review',
    });
  }, [state, connections.data, businessId]);

  useEffect(() => {
    if (step !== 'summary' || !state || !businessId || state.platforms.length === 0) return;
    let live = true;
    api<{ estimate: AutomationEstimate }>('/automations/estimate', {
      method: 'POST',
      body: {
        businessId,
        cadence: state.cadence,
        duration: state.duration,
        platforms: state.platforms,
      },
    })
      .then((res) => live && setEstimate(res.estimate))
      .catch((err: unknown) => live && toast.error(errorText(err)));
    return () => {
      live = false;
    };
  }, [step, state, businessId, errorText]);

  if (ready && !businessId)
    return (
      <EmptyState
        illustration="business"
        title={t('list.pickTitle')}
        description={t('list.pickBody')}
      />
    );

  const header = (
    <PageHeader
      title={t('wizard.title')}
      description={t('list.description')}
      actions={
        <Button asChild variant="outline">
          <Link href="/automations">{t('detail.back')}</Link>
        </Button>
      }
    />
  );
  if (!state)
    return (
      <>
        {header}
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('list.loading')}
        </p>
      </>
    );

  const patch = (next: Partial<WizardState>) => setState((s) => (s ? { ...s, ...next } : s));
  const index = STEPS.indexOf(step);
  const accounts: Record<string, string> = {};
  for (const p of state.platforms) {
    const only = connectionsFor(p, connections.data?.data, businessId);
    if (only[0]) accounts[p] = only[0].id;
  }
  const canNext = step !== 'channels' || state.platforms.length > 0;

  const submit = async () => {
    if (!businessId) return;
    setSubmitting(true);
    try {
      const { automation } = await api<{ automation: AutomationSummary }>('/automations', {
        method: 'POST',
        body: {
          businessId,
          ...(state.name.trim() && { name: state.name.trim() }),
          cadence: state.cadence,
          duration: state.duration,
          platforms: state.platforms,
          targets: buildTargets(state.platforms, accounts),
          approvalMode: state.approvalMode,
          timezone: defaultZone(),
        },
        idempotencyKey: newIdempotencyKey(),
      });
      await api(`/automations/${automation.id}/start`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('wizard.started'));
      router.push(`/automations/${automation.id}`);
    } catch (err) {
      toast.error(errorText(err));
      setSubmitting(false);
    }
  };

  return (
    <>
      {header}
      <ol className="mb-8 flex flex-wrap gap-2" aria-label={t('wizard.progress')}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => i < index && setStep(s)}
              aria-current={s === step ? 'step' : undefined}
              disabled={i > index}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition',
                s === step && 'border-primary bg-primary text-primary-foreground',
                i < index && 'border-primary/40 text-primary hover:bg-primary/8',
                i > index && 'border-border text-muted-foreground',
              )}
            >
              <span className="tabular-nums">
                {i < index ? <Check className="size-3" /> : i + 1}
              </span>
              {t(`wizard.steps.${s}`)}
            </button>
          </li>
        ))}
      </ol>

      <section className="max-w-2xl space-y-6" aria-labelledby="wizard-step-title">
        <h2 id="wizard-step-title" className="font-display text-3xl leading-none">
          {t(`wizard.${step}Title`)}
        </h2>

        {step === 'channels' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('wizard.channelsHint')}</p>
            <PlatformChips
              value={state.platforms}
              onChange={(p) => p.platforms && patch({ platforms: p.platforms })}
            />
            <ul className="space-y-1 text-xs text-muted-foreground">
              {state.platforms
                .filter((p) => !accounts[p])
                .map((p) => (
                  <li key={p}>{t('wizard.noAccount', { platform: f.platform(p) })}</li>
                ))}
            </ul>
          </div>
        )}

        {step === 'cadence' && (
          <div className="grid gap-6">
            <div
              role="radiogroup"
              aria-label={t('wizard.cadenceTitle')}
              className="grid gap-3 sm:grid-cols-2"
            >
              {(['per_day', 'per_week'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={state.cadence.mode === mode}
                  onClick={() =>
                    patch({
                      cadence:
                        mode === 'per_day' ? { mode, postsPerDay: 1 } : { mode, postsPerWeek: 3 },
                    })
                  }
                  className={cn(
                    'rounded-xl border p-4 text-start transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    state.cadence.mode === mode
                      ? 'border-primary bg-primary/6'
                      : 'border-border hover:bg-secondary/60',
                  )}
                >
                  <span className="block font-medium">{t(`wizard.mode.${mode}`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`wizard.mode.${mode}Hint`)}
                  </span>
                </button>
              ))}
            </div>
            <Field
              id="automation-count"
              label={
                state.cadence.mode === 'per_day'
                  ? t('wizard.mode.per_day')
                  : t('wizard.mode.per_week')
              }
            >
              <Input
                id="automation-count"
                type="number"
                min={1}
                max={state.cadence.mode === 'per_day' ? 3 : 21}
                value={
                  state.cadence.mode === 'per_day'
                    ? state.cadence.postsPerDay
                    : state.cadence.postsPerWeek
                }
                onChange={(e) => {
                  const n = Math.max(
                    1,
                    Math.min(
                      state.cadence.mode === 'per_day' ? 3 : 21,
                      Number(e.target.value) || 1,
                    ),
                  );
                  patch({
                    cadence:
                      state.cadence.mode === 'per_day'
                        ? { mode: 'per_day', postsPerDay: n }
                        : { mode: 'per_week', postsPerWeek: n },
                  });
                }}
                className="w-28"
              />
            </Field>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted-foreground">
                {t('wizard.durationTitle')}
              </legend>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={state.duration === d}
                    onClick={() => patch({ duration: d })}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-sm transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      state.duration === d
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border hover:bg-secondary',
                    )}
                  >
                    {t(`duration.${d}`)}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        )}

        {step === 'mix' && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('wizard.mixHint')}</p>
            <p className="flex items-start gap-2 rounded-xl border border-success/30 bg-success/8 p-3">
              <Leaf className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              {t('wizard.lowestCost')}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/business?tab=angles">{t('wizard.mixLink')}</Link>
            </Button>
          </div>
        )}

        {step === 'approval' && (
          <div role="radiogroup" aria-label={t('wizard.approvalTitle')} className="grid gap-3">
            {(['review', 'auto'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={state.approvalMode === mode}
                onClick={() => patch({ approvalMode: mode })}
                className={cn(
                  'rounded-xl border p-4 text-start transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  state.approvalMode === mode
                    ? 'border-primary bg-primary/6'
                    : 'border-border hover:bg-secondary/60',
                )}
              >
                <span className="block font-medium">{t(`approval.${mode}`)}</span>
                <span className="block text-xs text-muted-foreground">
                  {t(`approval.${mode}Hint`)}
                </span>
              </button>
            ))}
          </div>
        )}

        {step === 'summary' && (
          <div className="space-y-5">
            <Field id="automation-name" label={t('wizard.name')}>
              <Input
                id="automation-name"
                maxLength={80}
                value={state.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            {!estimate ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t('wizard.estimating')}
              </p>
            ) : (
              <dl className="grid gap-3 rounded-2xl border border-border bg-card p-5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('wizard.summaryPostsLabel')}</dt>
                  <dd className="font-medium">
                    {t('wizard.summaryPosts', { count: estimate.posts, days: estimate.periodDays })}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('wizard.summarySplitLabel')}</dt>
                  <dd className="text-end">
                    {Object.entries(estimate.split).map(([format, count]) => (
                      <span key={format} className="block">
                        {t('wizard.summarySplit', {
                          format: tb(`format.${format as FormatKey}`),
                          count,
                        })}
                      </span>
                    ))}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('wizard.allowanceLabel')}</dt>
                  <dd>{t('wizard.allowance', { count: estimate.allowanceUnits })}</dd>
                </div>
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Leaf className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                  {estimate.paidPosts > 0
                    ? t('wizard.paidPosts', { count: estimate.paidPosts })
                    : t('wizard.lowestCost')}
                </p>
                {showCosts && estimate.estimatePence !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {t('wizard.staffEstimate', { amount: f.pence(estimate.estimatePence) })}
                  </p>
                )}
              </dl>
            )}
          </div>
        )}

        <div className="flex justify-between gap-3 pt-2">
          <Button variant="ghost" disabled={index === 0} onClick={() => setStep(STEPS[index - 1]!)}>
            <ArrowLeft className="rtl:rotate-180" /> {t('wizard.back')}
          </Button>
          {step !== 'summary' ? (
            <Button disabled={!canNext} onClick={() => setStep(STEPS[index + 1]!)}>
              {t('wizard.next')} <ArrowRight className="rtl:rotate-180" />
            </Button>
          ) : (
            <Button
              disabled={submitting || !estimate || estimate.posts === 0}
              onClick={() => void submit()}
            >
              {submitting ? <Loader2 className="animate-spin" /> : <Check />} {t('wizard.create')}
            </Button>
          )}
        </div>
      </section>
    </>
  );
}
