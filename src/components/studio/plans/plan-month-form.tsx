'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2, CalendarRange, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { connectionsFor } from '../automation/automation';
import { useBusiness } from '../business-context';
import { BusinessHashtagsNote } from '../hashtags/business-hashtags-panel';
import { defaultZone } from '../calendar/drip-queue';
import { PlatformChips } from '../create/create-options';
import { defaultPlatforms } from '../create/formats';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { Field, NativeSelect } from '../review/field';
import { AllowancePanel } from './plan-parts';
import {
  buildPlanBody,
  requestedPosts,
  validatePlanForm,
  type Plan,
  type PlanDefaults,
  type PlanFormState,
  type PlanProblem,
} from './plan-model';

// 20.9 — "Plan my month": the window (start, length ≤ 31 days), posts a day (1–4, or the
// business's posting times), the video / slideshow slider (default 50/50), platforms and the
// account each posts to. "Draft my month" creates the plan (POST /content-plans); Claude writes
// the topics in the background and the editor opens on /plans/:id.

const POSTS_PER_DAY = [1, 2, 3, 4] as const;

export function PlanMonthForm() {
  const t = useTranslations('plans.new');
  const tp = useTranslations('plans.new.problems');
  const f = useFormat();
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
        icon={<Building2 className="size-8" strokeWidth={1.5} />}
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
    const found = validatePlanForm(form, d.maxDays);
    if (found.length) {
      setProblems(found);
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
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </p>
      </>
    );

  const slideshows = 100 - form.videoShare;
  const count = form.useDripSlots
    ? Math.round((d.postingTimesPerWeek * form.days) / 7)
    : requestedPosts(form.days, form.postsPerDay);
  return (
    <>
      {header}
      <form
        onSubmit={submit}
        className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]"
        aria-describedby="plan-estimate"
      >
        <div className="flex min-w-0 flex-col gap-6">
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

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {t('postsPerDay')}
            </legend>
            <div role="radiogroup" aria-label={t('postsPerDay')} className="flex flex-wrap gap-1.5">
              {POSTS_PER_DAY.map((n) => (
                <Choice
                  key={n}
                  checked={!form.useDripSlots && form.postsPerDay === n}
                  onSelect={() => patch({ postsPerDay: n, useDripSlots: false })}
                >
                  {t('postsPerDayOption', { count: n })}
                </Choice>
              ))}
              <Choice
                checked={form.useDripSlots}
                disabled={!d.hasPostingTimes}
                onSelect={() => patch({ useDripSlots: true })}
              >
                {t('useMyTimes')}
              </Choice>
            </div>
            <p className="text-xs text-muted-foreground">
              {d.hasPostingTimes
                ? t('useMyTimesHint', { count: d.postingTimesPerWeek })
                : t('noPostingTimes')}
            </p>
          </fieldset>

          <div className="flex flex-col gap-2">
            <label htmlFor="plan-mix" className="text-xs font-medium text-muted-foreground">
              {t('mix')}
            </label>
            <input
              id="plan-mix"
              type="range"
              min={0}
              max={100}
              step={5}
              value={form.videoShare}
              aria-valuetext={t('mixValue', { videos: form.videoShare, slideshows })}
              onChange={(e) => patch({ videoShare: Number(e.target.value) })}
              className="w-full accent-foreground"
            />
            <p className="tabular text-sm" aria-hidden>
              {t('mixValue', { videos: form.videoShare, slideshows })}
            </p>
            <p className="text-xs text-muted-foreground">{t('mixHint')}</p>
          </div>

          <PlatformChips
            value={form.platforms}
            onChange={(next) => next.platforms && patch({ platforms: next.platforms })}
          />
          {/* 20.13: the hashtags every planned post carries (Business settings → Hashtags). */}
          <BusinessHashtagsNote businessId={businessId} />
          <div className="grid gap-3 sm:grid-cols-2">
            {form.platforms.map((platform) => {
              const options = connectionsFor(platform, connections.data?.data, businessId);
              const id = `plan-account-${platform}`;
              return (
                <Field
                  key={platform}
                  id={id}
                  label={t('account', { platform: f.platform(platform) })}
                  hint={
                    options.length === 0 ? (
                      <>
                        {t('noAccount')}{' '}
                        <Link href="/connections" className="underline">
                          {t('connect')}
                        </Link>
                      </>
                    ) : undefined
                  }
                >
                  <NativeSelect
                    id={id}
                    value={form.accounts[platform] ?? ''}
                    disabled={options.length === 0}
                    onChange={(e) =>
                      patch({ accounts: { ...form.accounts, [platform]: e.target.value } })
                    }
                  >
                    <option value="">{t('chooseAccount')}</option>
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.platformAccountName}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              );
            })}
          </div>

          {problems.length > 0 && (
            <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
              {problems.map((p) => (
                <li key={p}>{p === 'daysRange' ? tp(p, { max: d.maxDays }) : tp(p)}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <CalendarRange />}
              {submitting ? t('submitting') : t('submit')}
            </Button>
            <p id="plan-estimate" className="text-sm text-muted-foreground" aria-live="polite">
              {t('estimate', { count, days: form.days })}
            </p>
          </div>
        </div>
        <aside className="flex flex-col gap-3">
          <AllowancePanel allowance={d.allowance} cost={d.cost} />
          <p className="text-xs text-muted-foreground">
            {t('costHint', {
              video: f.pence(d.typicalCostPence.VIDEO),
              slideshow: f.pence(d.typicalCostPence.SLIDESHOW),
            })}
          </p>
        </aside>
      </form>
    </>
  );
}

function Choice({
  checked,
  disabled = false,
  onSelect,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-foreground bg-secondary'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
