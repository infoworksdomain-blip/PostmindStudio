'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CalendarDays, Clapperboard, GalleryHorizontal, Layers } from 'lucide-react';
import { useFormat, type Tone } from '@/lib/client/format';
import { CALENDAR_DAY_IDS, type CalendarDayId } from '@/lib/studio/content-plans/calendar-days';
import { useShowCosts } from '../account/use-show-costs';
import { StateBadge } from '../primitives';
import {
  PLAN_ANGLES,
  REASON_KEYS,
  waitingToCreate,
  type CreatesAtFields,
  type ReasonKey,
  type ItemKind,
  type ItemStatus,
  type Plan,
  type PlanAllowance,
  type PlanAngle,
  type PlanCost,
  type PlanItem,
  type PlanStatus,
} from './plan-model';

// 20.9 — small pieces shared by the month-plan screens: status badges, an item's when / format /
// angle line, the allowance panel, and the notices (capped, held, paused). Spending figures are for
// platform staff only and the notices speak of "this month's limit", never spend (operator
// decision 2026-10-04).

const ITEM_TONE: Record<ItemStatus, Tone> = {
  PLANNED: 'neutral',
  QUEUED: 'neutral',
  GENERATING: 'live',
  READY: 'warn',
  SCHEDULED: 'good',
  POSTED: 'good',
  HELD: 'bad',
  FAILED: 'bad',
  SKIPPED: 'neutral',
  REMOVED: 'neutral',
};

const PLAN_TONE: Record<PlanStatus, Tone> = {
  DRAFTING: 'live',
  DRAFT: 'neutral',
  GENERATING: 'live',
  SCHEDULED: 'good',
  COMPLETED: 'good',
  CANCELLED: 'neutral',
};

export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  const t = useTranslations('plans.itemStatus');
  return <StateBadge label={t(status)} tone={ITEM_TONE[status]} />;
}

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const t = useTranslations('plans.status');
  return <StateBadge label={t(status)} tone={PLAN_TONE[status]} />;
}

const isAngle = (value: string): value is PlanAngle =>
  (PLAN_ANGLES as readonly string[]).includes(value);

/** "Tue 6 Oct, 12:30 · Video · How-to · Halloween" for one item. */
export function ItemMeta({ item, timezone }: { item: PlanItem; timezone: string }) {
  const t = useTranslations('plans');
  const f = useFormat();
  const Icon =
    item.kind === 'VIDEO' ? Clapperboard : item.kind === 'CAROUSEL' ? GalleryHorizontal : Layers;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <time dateTime={item.slotAt} className="tabular font-medium text-foreground">
        {f.date(item.slotAt, { timeStyle: 'short', timeZone: timezone })}
      </time>
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-1">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
        {t(`kind.${item.kind}`)}
      </span>
      {isAngle(item.angle) && (
        <>
          <span aria-hidden>·</span>
          <span>{t(`angle.${item.angle}`)}</span>
        </>
      )}
      {item.calendarDay && <CalendarDayBadge id={item.calendarDay} />}
    </p>
  );
}

const isCalendarDay = (value: string): value is CalendarDayId =>
  (CALENDAR_DAY_IDS as readonly string[]).includes(value);

export function CalendarDayBadge({ id }: { id: string }) {
  const t = useTranslations('plans.calendarDay');
  if (!isCalendarDay(id)) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
      <CalendarDays className="size-3" aria-hidden />
      {t(id)}
    </span>
  );
}

export function KindLabel({ kind }: { kind: ItemKind }) {
  const t = useTranslations('plans.kind');
  return <>{t(kind)}</>;
}

/** The month's allowance (and, for staff, spending), with the link to buy a video pack. */
export function AllowancePanel({ allowance, cost }: { allowance: PlanAllowance; cost: PlanCost }) {
  const t = useTranslations('plans.allowance');
  const tUsage = useTranslations('shell.usage');
  const f = useFormat();
  const showCosts = useShowCosts();
  return (
    <section
      aria-labelledby="plan-allowance"
      className="rounded-xl border border-border bg-card p-4 text-sm"
    >
      <h2 id="plan-allowance" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
        <li>
          {allowance.remaining === null || allowance.limit === null
            ? t('unlimited')
            : t('videos', {
                remaining: Math.max(0, allowance.remaining - allowance.credits),
                limit: allowance.limit,
              })}
          {allowance.credits > 0 && <> {t('credits', { count: allowance.credits })}</>}
        </li>
        <li>{tUsage('quickPostsNote')}</li>
        {showCosts && (
          <li data-testid="plan-spend">
            {cost.capPence === null
              ? t('noCap')
              : t('spend', { spent: f.pence(cost.spentPence), cap: f.pence(cost.capPence) })}
          </li>
        )}
      </ul>
      <Link
        href="/settings/billing#topups"
        className="mt-2 inline-block text-xs underline underline-offset-2"
      >
        {t('buyPack')}
      </Link>
    </section>
  );
}

/** Why the draft has fewer posts than the window allows. */
export function CappedNotice({
  plan,
}: {
  plan: Pick<Plan, 'cappedReason' | 'requestedCount' | 'items'>;
}) {
  const t = useTranslations('plans.capped');
  if (!plan.cappedReason) return null;
  const key = plan.cappedReason === 'cost_cap' ? 'monthLimit' : 'allowancePack';
  const count = plan.items.filter((i) => i.status !== 'REMOVED' && i.status !== 'SKIPPED').length;
  return (
    <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      {t.rich(key, {
        count,
        requested: plan.requestedCount,
        link: (chunks) => (
          <Link href="/settings/billing#topups" className="underline underline-offset-2">
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}

export function HoldNotice({ reason }: { reason: Plan['holdReason'] }) {
  const t = useTranslations('plans.hold');
  if (!reason) return null;
  return (
    <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      {t(reason === 'cost_cap' ? 'monthLimit' : reason)}
    </p>
  );
}

/**
 * 23.6 rolling generation: "Scheduled to be created on Thu 9 Oct, 09:00" for a queued post Studio
 * starts making later, in the plan's time zone. Nothing once it is due or already being made.
 */
export function CreatesAtText({
  item,
  timezone,
  now,
}: {
  item: CreatesAtFields;
  timezone: string;
  now: number;
}) {
  const t = useTranslations('plans.view');
  const f = useFormat();
  if (!waitingToCreate(item, now) || !item.createsAt) return null;
  const date = f.date(item.createsAt, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  });
  return (
    <p className="text-xs text-muted-foreground">
      <time dateTime={item.createsAt}>{t('createsAt', { date })}</time>
    </p>
  );
}

/** A known status reason in the reader's language (unknown codes show nothing). */
const isReason = (value: string): value is ReasonKey =>
  (REASON_KEYS as readonly string[]).includes(value);

export function ReasonText({ reason }: { reason: string | null }) {
  const t = useTranslations('plans.reason');
  if (!reason || !isReason(reason)) return null;
  return <p className="text-xs text-muted-foreground">{t(reason)}</p>;
}
