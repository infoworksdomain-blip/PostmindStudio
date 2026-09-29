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
  isSubscriptionStatus,
  PLAN_TIERS,
  type AdminEntitlementsResponse,
  type PlanTier,
} from '../../billing/types';

// Phase 18 §P.3 / §P.4 — staff entitlement overrides for one organisation
// (GET|PUT|DELETE /admin/organisations/:id/entitlements): the effective plan, the stored row, the
// current override, subscriptions; a form to set tier, access, custom limits, the ENTERPRISE
// agreed monthly price (checked live against the minimum for the organisation's monthly cost cap,
// and blocked here before the server's 422), an optional expiry and a required reason; and
// removing the override (reason required). Every change is audited server side.

type View = AdminEntitlementsResponse['entitlements'];
type Access = 'full' | 'read_only' | 'none';

const ACCESS: readonly Access[] = ['full', 'read_only', 'none'];
const SOURCES = ['stripe', 'trial', 'admin', 'core', 'none'] as const;
type Source = (typeof SOURCES)[number];
const isSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);
const isAccess = (s: string): s is Access => (ACCESS as readonly string[]).includes(s);

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

function Summary({ view }: { view: View }) {
  const t = useTranslations('billing.admin.entitlements');
  const tTier = useTranslations('shell.usage.tiers');
  const tStatus = useTranslations('billing.subscriptionStatus');
  const tInterval = useTranslations('pricing.interval');
  const f = useFormat();
  const e = view.effective;
  const access = (a: string) => (isAccess(a) ? t(`accessValues.${a}`) : a);
  const source = (s: string) => (isSource(s) ? t(`sourceValues.${s}`) : s);
  const tierName = (tier: string | null) =>
    tier && (PLAN_TIERS as readonly string[]).includes(tier)
      ? tTier(tier as PlanTier)
      : (tier ?? '—');
  return (
    <div className="grid gap-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('tier')}</dt>
        <dd className="font-medium">{tierName(e.tier)}</dd>
        <dt className="text-muted-foreground">{t('access')}</dt>
        <dd>{access(e.access)}</dd>
        <dt className="text-muted-foreground">{t('source')}</dt>
        <dd>{source(e.source)}</dd>
        {e.graceUntil && (
          <>
            <dt className="text-muted-foreground">{t('graceUntil')}</dt>
            <dd>{f.date(e.graceUntil)}</dd>
          </>
        )}
      </dl>
      <div className="grid gap-1">
        <h3 className="font-medium">{t('stored')}</h3>
        <p className="text-muted-foreground">
          {view.stored
            ? t('storedSummary', {
                tier: tierName(view.stored.tier),
                access: access(view.stored.access),
                source: source(view.stored.source),
                when: f.relative(view.stored.updatedAt),
              })
            : t('noStored')}
        </p>
      </div>
      <div className="grid gap-1">
        <h3 className="font-medium">{t('override')}</h3>
        {view.admin ? (
          <div className="grid gap-0.5 text-muted-foreground">
            <p>{t('overrideReason', { reason: view.admin.reason })}</p>
            <p>{t('overrideSetAt', { when: f.relative(view.admin.setAt) })}</p>
            <p>
              {view.admin.expiresAt
                ? t('expires', { date: f.date(view.admin.expiresAt) })
                : t('noExpiry')}
            </p>
            {view.admin.monthlyPricePence != null && (
              <p>{t('overridePrice', { amount: f.pence(view.admin.monthlyPricePence) })}</p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">{t('noOverride')}</p>
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="font-medium">{t('subscriptions')}</h3>
        {view.subscriptions.length === 0 ? (
          <p className="text-muted-foreground">{t('noSubscriptions')}</p>
        ) : (
          <ul className="grid gap-1">
            {view.subscriptions.map((s) => (
              <li key={s.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {isSubscriptionStatus(s.status) ? tStatus(s.status) : s.status}
                </span>{' '}
                {t('subscriptionLine', {
                  tier: tierName(s.tier),
                  interval:
                    s.interval === 'month' || s.interval === 'year'
                      ? tInterval(s.interval)
                      : (s.interval ?? '—'),
                  date: f.date(s.currentPeriodEnd, { dateStyle: 'medium' }),
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
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
  const tTier = useTranslations('shell.usage.tiers');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [tier, setTier] = useState<PlanTier | ''>('');
  const [access, setAccess] = useState<Access | ''>('');
  const [limits, setLimits] = useState(emptyLimits);
  const [price, setPrice] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);

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
  const valid = reason.trim().length >= 3 && priceProblem === null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const limitsBody = limitsFromDraft(limits);
    setPending(true);
    try {
      const res = await api<AdminEntitlementsResponse>(path, {
        method: 'PUT',
        body: {
          ...(tier && { tier }),
          ...(access && { access }),
          ...(limitsBody && { limits: limitsBody }),
          ...(enterprise && { monthlyPricePence: pricePence }),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          reason: reason.trim(),
        },
      });
      toast.success(t('saved'));
      setReason('');
      onSaved(res.entitlements);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const setLimit = (key: LimitKey, patch: Partial<LimitDraft>) =>
    setLimits((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  return (
    <form onSubmit={save} aria-label={t('title')} className="grid gap-4 text-sm">
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
                    onChange={(e) => setLimit(key, { value: e.target.value })}
                  />
                  {!NO_UNLIMITED.has(key) && (
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={d.unlimited}
                        aria-label={t('unlimitedAria', { limit: label })}
                        onChange={(e) => setLimit(key, { unlimited: e.target.checked })}
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
  );
}

function ClearOverride({ path, onCleared }: { path: string; onCleared: (v: View) => void }) {
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
        <Button type="submit" variant="destructive" disabled={pending || reason.trim().length < 3}>
          {pending && <Loader2 className="animate-spin" />}
          {t('button')}
        </Button>
      </div>
    </form>
  );
}

function EntitlementsDetail({ orgId }: { orgId: string }) {
  const t = useTranslations('billing.admin.entitlements');
  const path = `/admin/organisations/${encodeURIComponent(orgId)}/entitlements`;
  const res = useApi<AdminEntitlementsResponse>(path);
  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label={t('loading')} className="h-48" />;
  const view = res.data.entitlements;
  const update = (next: View) => void res.mutate({ entitlements: next }, { revalidate: false });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title={t('effective')}>
        <Summary view={view} />
      </Section>
      <div className="grid gap-6">
        <Section title={t('form.title')}>
          <OverrideForm view={view} path={path} onSaved={update} />
        </Section>
        {view.admin && (
          <Section title={t('clear.title')}>
            <ClearOverride path={path} onCleared={update} />
          </Section>
        )}
      </div>
    </div>
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
        <div className="grid gap-1.5">
          <Label htmlFor="ent-org-lookup">{t('orgIdLabel')}</Label>
          <Input
            id="ent-org-lookup"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('orgIdPlaceholder')}
            className="w-72"
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
