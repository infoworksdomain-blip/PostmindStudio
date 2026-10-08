'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2, CalendarRange, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import {
  CREATE_BLOCK_NOTICE_ID,
  CreateBlockedNotice,
  useCreateBlock,
} from '../account/create-access';
import { useShowCosts } from '../account/use-show-costs';
import { connectionsFor, publishablePlatforms } from '../automation/automation';
import { useBusiness } from '../business-context';
import { defaultZone } from '../calendar/drip-queue';
import { defaultPlatforms } from '../create/formats';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { Field } from '../review/field';
import { PlanAccountsNotice, PlanFormOptions } from './plan-form-options';
import { AllowancePanel } from './plan-parts';
import { PlanPreview } from './plan-preview';
import {
  buildPlanBody,
  planPreview,
  validatePlanForm,
  type Plan,
  type PlanDefaults,
  type PlanFormState,
  type PlanProblem,
} from './plan-model';

// 20.9 — "Plan my month", the flagship planner. 25.9: one prompt first — the month's start and
// length (30 days by default, up to 31) and one "Draft my month" button, with the defaults read
// out as a sentence; posts a day, the mix, platforms and accounts sit behind "More options"
// (opened by itself when one of them needs an answer). Beside it, what Studio will make. "Draft
// my month" creates the plan (POST /content-plans); Claude writes the topics in the background
// and the editor opens on /plans/:id.

/** Problems that are answered inside "More options". */
const OPTION_PROBLEMS: ReadonlySet<PlanProblem> = new Set(['platformRequired', 'accountRequired']);

export function PlanMonthForm() {
  const t = useTranslations('plans.new');
  const tp = useTranslations('plans.new.problems');
  const block = useCreateBlock();
  const f = useFormat();
  // Operator decision 2026-10-04: what a post typically costs to make is for platform staff only.
  const showCosts = useShowCosts();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const [zone] = useState(defaultZone);
  const defaults = useApi<{ defaults: PlanDefaults }>(
    businessId ? '/content-plans/defaults' : null,
    { businessId, timezone: zone },
  );
  const connections = useApi<{ data: PlatformConnection[]; meta?: MetaConnectInfo }>(
    '/platform-connections',
  );
  const [form, setForm] = useState<PlanFormState | null>(null);
  const [problems, setProblems] = useState<PlanProblem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const d = defaults.data?.defaults;
  useEffect(() => {
    if (!d || form || !connections.data) return;
    const platforms = defaultPlatforms(connections.data.data, businessId);
    const accounts: Record<string, string> = {};
    for (const p of platforms) {
      const only = connectionsFor(p, connections.data.data, businessId);
      if (only.length === 1 && only[0]) accounts[p] = only[0].id;
    }
    setForm({
      startDate: d.startDate,
      days: d.days,
      postsPerDay: d.postsPerDay,
      useDripSlots: false,
      videoShare: d.videoShare,
      platforms,
      accounts,
    });
  }, [d, form, connections.data, businessId]);

  if (ready && !businessId)
    return (
      <EmptyState
        media={<Building2 className="size-8" strokeWidth={1.5} />}
        title={t('noBusiness.title')}
        description={t('noBusiness.description')}
        action={
          <Button asChild variant="outline">
            <Link href="/business">{t('noBusiness.action')}</Link>
          </Button>
        }
      />
    );

  const patch = (next: Partial<PlanFormState>) => {
    setForm((current) => (current ? { ...current, ...next } : current));
    setProblems([]);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form || !businessId || !d) return;
    const found = validatePlanForm(
      form,
      d.maxDays,
      publishablePlatforms(form.platforms, connections.data?.data, businessId),
    );
    if (found.length) {
      setProblems(found);
      if (found.some((p) => OPTION_PROBLEMS.has(p))) setOptionsOpen(true);
      return;
    }
    setSubmitting(true);
    try {
      const { plan } = await api<{ plan: Plan }>('/content-plans', {
        method: 'POST',
        body: buildPlanBody(form, businessId, d.timezone),
        idempotencyKey: newIdempotencyKey(),
      });
      router.push(`/plans/${plan.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setSubmitting(false);
    }
  }

  const header = (
    <PageHeader
      eyebrow={t('eyebrow')}
      title={t('title')}
      description={t('description')}
      actions={
        <Button asChild variant="outline">
          <Link href="/plans">{t('yourPlans')}</Link>
        </Button>
      }
    />
  );
  if (defaults.error)
    return (
      <>
        {header}
        <ErrorState error={defaults.error} onRetry={() => void defaults.mutate()} />
      </>
    );
  if (!form || !d)
    return (
      <>
        {header}
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> {t('loading')}
        </p>
      </>
    );

  const withAccounts = publishablePlatforms(form.platforms, connections.data?.data, businessId);
  const preview = planPreview(form, d.postingTimesPerWeek);
  const perDay = form.useDripSlots
    ? t('prompt.yourTimes')
    : t('postsPerDayOption', { count: form.postsPerDay });
  return (
    <>
      {header}
      <form
        onSubmit={submit}
        className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]"
        aria-describedby="plan-estimate"
      >
        <section
          aria-labelledby="plan-prompt-title"
          className="flex min-w-0 flex-col gap-6 rounded-panel border border-border bg-card p-5 shadow-raised sm:p-7"
        >
          <div className="flex flex-col gap-1.5">
            <h2 id="plan-prompt-title" className="text-xl font-semibold tracking-tight">
              {t('prompt.title')}
            </h2>
            <p className="text-sm text-foreground-secondary">{t('prompt.body')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="plan-start" label={t('start')} hint={t('startHint')}>
              <Input
                id="plan-start"
                type="date"
                required
                value={form.startDate}
                min={d.startDate < form.startDate ? undefined : d.startDate}
                onChange={(e) => patch({ startDate: e.target.value })}
              />
            </Field>
            <Field id="plan-days" label={t('days')} hint={t('daysHint', { max: d.maxDays })}>
              <Input
                id="plan-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={d.maxDays}
                value={form.days}
                onChange={(e) => patch({ days: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-sm" data-testid="plan-summary">
              {t('prompt.summary', {
                perDay,
                videos: form.videoShare,
                platforms: form.platforms.length
                  ? f.list(form.platforms.map((p) => f.platform(p)))
                  : t('prompt.noPlatforms'),
              })}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              aria-expanded={optionsOpen}
              aria-controls="plan-options"
              onClick={() => setOptionsOpen((open) => !open)}
            >
              <ChevronDown
                className={cn(
                  'transition-transform duration-(--duration-fast) motion-reduce:transition-none',
                  optionsOpen && 'rotate-180',
                )}
              />
              {t('prompt.options')}
            </Button>
            <div id="plan-options" hidden={!optionsOpen} className="pt-2">
              <PlanFormOptions
                form={form}
                defaults={d}
                businessId={businessId ?? ''}
                connections={connections.data?.data}
                withAccounts={withAccounts}
                patch={patch}
              />
            </div>
          </div>
          <PlanAccountsNotice platforms={form.platforms} withAccounts={withAccounts} />
          <CreateBlockedNotice block={block} />
          {problems.length > 0 && (
            <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive-foreground">
              {problems.map((p) => (
                <li key={p}>{p === 'daysRange' ? tp(p, { max: d.maxDays }) : tp(p)}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              size="lg"
              loading={submitting}
              disabled={block === 'read_only'}
              aria-describedby={block ? CREATE_BLOCK_NOTICE_ID : undefined}
            >
              {!submitting && <CalendarRange />}
              {submitting ? t('submitting') : t('submit')}
            </Button>
            <p id="plan-estimate" className="text-sm text-muted-foreground" aria-live="polite">
              {t('estimate', { count: preview.count, days: form.days })}
            </p>
          </div>
        </section>
        <aside className="flex flex-col gap-4">
          <PlanPreview preview={preview} platforms={form.platforms} />
          <AllowancePanel allowance={d.allowance} cost={d.cost} />
          {showCosts && (
            <p className="text-xs text-muted-foreground" data-testid="plan-cost-hint">
              {t('costHint', {
                video: f.pence(d.typicalCostPence.VIDEO),
                slideshow: f.pence(d.typicalCostPence.SLIDESHOW),
              })}
            </p>
          )}
        </aside>
      </form>
    </>
  );
}
