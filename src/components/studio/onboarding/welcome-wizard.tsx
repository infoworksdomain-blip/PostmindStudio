'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { useMe } from '../account/use-me';
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
  WIZARD_STEPS,
} from './onboarding';
import { CreateOrganisationStep, FirstBusinessStep } from './setup-steps';
import { StepIndicator } from './step-indicator';

// BACKLOG 13.14 — the /welcome first-run wizard (spec 14.5). Phase 18 Track E order: create the
// organisation → first business (setup-steps.tsx, before any wizard state exists) → Brand kit →
// Connect → First video → Celebrate. Progress is saved with PATCH /onboarding after every move
// and resumed from GET.
// 25.6: a calm full-width wizard — "Step n of m" progress, each step on one quiet panel, optional
// steps skippable ("Skip for now"), and Back / Skip / Continue in one footer that sticks to the
// bottom of the screen on phones.

const PANEL = 'rounded-panel border border-border bg-card p-5 sm:p-8 md:p-10';

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
      return <CelebrateStep projectId={onboarding.firstVideoProjectId} businessId={businessId} />;
  }
}

export function WelcomeWizard() {
  const t = useTranslations('onboarding.wizard');
  const tc = useTranslations('common.actions');
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const me = useMe();
  const search = useSearchParams();
  // Phase 18: no organisation yet (403 no_organisation), or "New organisation" in the switcher.
  const needsOrganisation =
    me.error?.code === 'no_organisation' || search?.get('new') === 'organisation';
  // Wait for /me so a user without an organisation never asks for (403) wizard state.
  const meSettled = Boolean(me.data || me.error);
  const { data, error, mutate } = useApi<OnboardingResponse>(
    meSettled && !needsOrganisation ? ONBOARDING_PATH : null,
  );
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

  // 25.6: after Back / Skip / Continue, focus moves to the new step's panel (announced by its
  // name, and scrolled into view), not left on a button that may have gone.
  const panelRef = useRef<HTMLElement>(null);
  const lastShown = useRef(shown);
  useEffect(() => {
    if (lastShown.current && shown && lastShown.current !== shown) panelRef.current?.focus();
    lastShown.current = shown;
  }, [shown]);

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
          <Button variant="ghost" disabled={saving} onClick={() => void move({ dismissed: true })}>
            {t('skipSetup')}
          </Button>
        ) : undefined
      }
    />
  );

  if (needsOrganisation)
    return (
      <>
        {header}
        <StepIndicator
          current={null}
          completed={[]}
          setup={{ organisation: 'current', business: 'todo' }}
        />
        <section aria-label={t('currentStep')} className={PANEL}>
          <CreateOrganisationStep />
        </section>
      </>
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
        <Skeleton className="h-64 rounded-panel" aria-label={t('loading')} />
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
        <StepIndicator
          current={null}
          completed={[]}
          setup={{ organisation: 'done', business: 'current' }}
        />
        <section aria-label={t('currentStep')} className={PANEL}>
          <FirstBusinessStep />
        </section>
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
      <StepIndicator
        current={step}
        completed={onboarding.completed}
        setup={{ organisation: 'done', business: 'done' }}
      />
      <section
        ref={panelRef}
        tabIndex={-1}
        aria-label={t('currentStep')}
        className={cn(PANEL, 'scroll-mt-24 outline-none')}
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
      <div
        className={cn(
          'mt-6 flex items-center justify-between gap-3',
          // Phones: always in reach, above the home indicator.
          'max-md:sticky max-md:bottom-0 max-md:z-(--z-sticky) max-md:-mx-4 max-md:border-t max-md:border-border max-md:bg-background/95 max-md:px-4 max-md:pt-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:backdrop-blur',
        )}
      >
        <Button
          variant="ghost"
          disabled={saving || step === WIZARD_STEPS[0]}
          onClick={() => void move({ step: previousStep(step) })}
        >
          <ArrowLeft className="rtl:-scale-x-100" /> {tc('back')}
        </Button>
        <div className="flex items-center gap-2">
          {saving && (
            <Loader2
              className="size-4 animate-spin text-foreground-secondary"
              aria-label={t('saving')}
            />
          )}
          {step !== 'celebrate' && (
            <Button
              variant="ghost"
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
