'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Building2, Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { BrandKitStep } from './brand-kit-step';
import { CelebrateStep, SetupFinished } from './celebrate-step';
import { ConnectStep } from './connect-step';
import { FirstVideoStep } from './first-video-step';
import {
  nextStep,
  ONBOARDING_PATH,
  previousStep,
  withCompleted,
  type Onboarding,
  type OnboardingPatch,
  type OnboardingResponse,
  type WizardStep,
} from './onboarding';
import { StepIndicator } from './step-indicator';

// BACKLOG 13.14 — the /welcome first-run wizard (spec 14.5): Connect → Brand kit → First video →
// Celebrate. Progress is saved with PATCH /onboarding after every move and resumed from GET.

function StepBody({
  step,
  onboarding,
  businessId,
  onReady,
  onCreated,
}: {
  step: WizardStep;
  onboarding: Onboarding;
  businessId: string;
  onReady: (ready: boolean) => void;
  onCreated: (projectId: string) => Promise<void>;
}) {
  switch (step) {
    case 'connect':
      return <ConnectStep businessId={businessId} onReady={onReady} />;
    case 'brand_kit':
      return <BrandKitStep businessId={businessId} onReady={onReady} />;
    case 'first_video':
      return (
        <FirstVideoStep
          businessId={businessId}
          projectId={onboarding.firstVideoProjectId}
          onCreated={onCreated}
        />
      );
    case 'celebrate':
      return <CelebrateStep projectId={onboarding.firstVideoProjectId} />;
  }
}

export function WelcomeWizard() {
  const t = useTranslations('onboarding.wizard');
  const tc = useTranslations('common.actions');
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const { data, error, mutate } = useApi<OnboardingResponse>(ONBOARDING_PATH);
  // Whether each step's own requirement is met (reported by the step component).
  const [readyFor, setReadyFor] = useState<Partial<Record<WizardStep, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const shown = data?.onboarding.step;
  const onReady = useCallback(
    (value: boolean) => {
      if (shown && shown !== 'done') setReadyFor((prev) => ({ ...prev, [shown]: value }));
    },
    [shown],
  );

  const save = useCallback(
    async (patch: OnboardingPatch) => {
      const res = await api<OnboardingResponse>(ONBOARDING_PATH, { method: 'PATCH', body: patch });
      await mutate(res, { revalidate: false });
    },
    [mutate],
  );

  async function move(patch: OnboardingPatch) {
    setSaving(true);
    try {
      await save(patch);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const header = (
    <PageHeader
      eyebrow={t('eyebrow')}
      title={t('title')}
      description={t('description')}
      actions={
        data && !data.onboarding.dismissedAt && data.onboarding.step !== 'done' ? (
          <Button variant="link" disabled={saving} onClick={() => void move({ dismissed: true })}>
            {t('skipSetup')}
          </Button>
        ) : undefined
      }
    />
  );

  if (error)
    return (
      <>
        {header}
        <ErrorState error={error} onRetry={() => void mutate()} />
      </>
    );
  if (!data || !ready)
    return (
      <>
        {header}
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      </>
    );

  const { onboarding } = data;
  if (onboarding.step === 'done')
    return (
      <>
        {header}
        <SetupFinished />
      </>
    );
  if (onboarding.dismissedAt)
    return (
      <>
        {header}
        <EmptyState
          title={t('skipped.title')}
          description={t('skipped.description')}
          action={
            <Button disabled={saving} onClick={() => void move({ dismissed: false })}>
              {t('skipped.resume')}
            </Button>
          }
        />
      </>
    );
  if (!businessId)
    return (
      <>
        {header}
        <EmptyState
          icon={<Building2 className="size-8" strokeWidth={1.5} />}
          title={t('noBusiness.title')}
          description={t('noBusiness.description')}
          action={
            <Button asChild variant="outline">
              <Link href="/business">{t('noBusiness.action')}</Link>
            </Button>
          }
        />
      </>
    );

  const step = onboarding.step;
  const canContinue =
    step === 'first_video'
      ? onboarding.firstVideoProjectId !== null
      : step === 'celebrate' || readyFor[step] === true;

  return (
    <>
      {header}
      <StepIndicator current={step} completed={onboarding.completed} />
      <section
        aria-label={t('currentStep')}
        className="rounded-xl border border-border bg-card p-6 md:p-8"
      >
        <StepBody
          key={step}
          step={step}
          onboarding={onboarding}
          businessId={businessId}
          onReady={onReady}
          onCreated={(firstVideoProjectId) => save({ firstVideoProjectId })}
        />
      </section>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          disabled={saving || step === 'connect'}
          onClick={() => void move({ step: previousStep(step) })}
        >
          <ArrowLeft className="rtl:-scale-x-100" /> {tc('back')}
        </Button>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="size-4 animate-spin" aria-label={t('saving')} />}
          {step !== 'celebrate' && (
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => void move({ step: nextStep(step) })}
            >
              {t('skipStep')}
            </Button>
          )}
          {step === 'celebrate' ? (
            <Button
              disabled={saving}
              onClick={() =>
                void move({ step: 'done', completed: withCompleted(onboarding.completed, step) })
              }
            >
              <Check /> {t('finish')}
            </Button>
          ) : (
            <Button
              disabled={saving || !canContinue}
              onClick={() =>
                void move({
                  step: nextStep(step),
                  completed: withCompleted(onboarding.completed, step),
                })
              }
            >
              {tc('continue')} <ArrowRight className="rtl:-scale-x-100" />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
