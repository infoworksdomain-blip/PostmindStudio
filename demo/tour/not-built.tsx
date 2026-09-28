import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  BLOCKERS,
  GROUP_ORDER,
  NOT_BUILT,
  totalDays,
  type Blocker,
  type NotBuiltItem,
} from './not-built-data';
import { Pill, TourHeader } from './ui';

// #/tour/not-built — every feature not built (or built but not yet run), why, and the plan.

const BLOCKER_TONE: Record<Blocker, 'bad' | 'warn' | 'neutral' | 'data' | 'live'> = {
  'missing endpoint': 'live',
  'blocked on a dependency': 'bad',
  'not started': 'neutral',
  'needs staging': 'data',
  'needs people': 'warn',
};

function formatDays(d: number): string {
  return `${d % 1 === 0 ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`;
}

function Summary({ items }: { items: readonly NotBuiltItem[] }) {
  const byGroup = GROUP_ORDER.map((g) => ({
    g,
    days: totalDays(items.filter((i) => i.group === g)),
  })).filter((x) => x.days > 0);
  const total = totalDays(items);
  return (
    <div className="mt-8 grid gap-6 md:grid-cols-[auto_1fr] md:items-end">
      <dl className="flex gap-8">
        <div>
          <dt className="text-xs text-muted-foreground">Items</dt>
          <dd className="font-display text-5xl leading-none tabular-nums">{items.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Estimated effort</dt>
          <dd className="font-display text-5xl leading-none tabular-nums">
            {Math.round(total)}
            <span className="ml-1 text-lg text-muted-foreground">days</span>
          </dd>
        </div>
      </dl>
      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">Effort by area</p>
        <div
          className="flex h-3 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={byGroup.map((x) => `${x.g}: ${x.days} days`).join('; ')}
        >
          {byGroup.map((x, i) => (
            <span
              key={x.g}
              title={`${x.g}: ${formatDays(x.days)}`}
              className={cn(
                'h-full border-r border-background last:border-0',
                ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'][i % 5],
              )}
              style={{ width: `${(x.days / total) * 100}%` }}
            />
          ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
          {byGroup.map((x, i) => (
            <li key={x.g} className="flex items-center gap-1">
              <span
                aria-hidden
                className={cn(
                  'size-2 rounded-full',
                  ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'][i % 5],
                )}
              />
              {x.g} · {formatDays(x.days)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Filters({
  value,
  onChange,
}: {
  value: Blocker | 'all';
  onChange: (v: Blocker | 'all') => void;
}) {
  const options: (Blocker | 'all')[] = ['all', ...BLOCKERS];
  return (
    <div role="radiogroup" aria-label="Filter by reason" className="mt-6 flex flex-wrap gap-1.5">
      {options.map((o) => {
        const count =
          o === 'all' ? NOT_BUILT.length : NOT_BUILT.filter((i) => i.blocker === o).length;
        const active = value === o;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              active
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
            )}
          >
            {o === 'all' ? 'Everything' : o}{' '}
            <span className="tabular-nums opacity-70">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function PlanList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <ul className="mt-1 space-y-1 text-sm">
        {items.map((s) => (
          <li key={s} className="flex gap-2">
            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-primary" />
            <span className="min-w-0 break-words">{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemCard({ item }: { item: NotBuiltItem }) {
  return (
    <article className="grid gap-4 border-t border-border py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{item.title}</h3>
          <Pill tone={BLOCKER_TONE[item.blocker]}>{item.blocker}</Pill>
        </div>
        <p className="mt-1.5 text-sm wrap-anywhere text-muted-foreground">{item.why}</p>
        <p className="mt-2 text-[0.7rem] text-muted-foreground">
          Recorded in <span className="font-mono">{item.source}</span>
        </p>
      </div>
      <div className="min-w-0 rounded-lg bg-muted/60 p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-semibold">Plan to complete</p>
          <p className="font-display text-xl leading-none tabular-nums">
            {formatDays(item.plan.days)}
          </p>
        </div>
        <div className="space-y-3">
          <PlanList label="Screens" items={item.plan.screens} />
          <PlanList label="Endpoints and jobs" items={item.plan.endpoints} />
          <p className="text-xs">
            <span className="text-muted-foreground">Depends on: </span>
            {item.plan.dependsOn}
          </p>
        </div>
      </div>
    </article>
  );
}

export function NotBuiltScreen() {
  const [filter, setFilter] = useState<Blocker | 'all'>('all');
  const shown = useMemo(
    () => (filter === 'all' ? NOT_BUILT : NOT_BUILT.filter((i) => i.blocker === filter)),
    [filter],
  );
  return (
    <div>
      <TourHeader
        eyebrow="Not built yet"
        title={
          <>
            What’s missing, <em className="text-primary">and how to finish it.</em>
          </>
        }
        lede={
          <p>
            Collected from the build log’s review lists and GATE 12 list, the backlog’s open items,
            the runbooks’ GAPs, the code’s NotImplementedError paths and the spec’s §14 screens.
            Each item says why it isn’t done and what completing it takes. Estimates are engineering
            days on the Studio side.
          </p>
        }
      >
        <Summary items={NOT_BUILT} />
        <Filters value={filter} onChange={setFilter} />
      </TourHeader>
      <div className="space-y-12" aria-live="polite">
        {GROUP_ORDER.map((group) => {
          const items = shown.filter((i) => i.group === group);
          if (items.length === 0) return null;
          const headingId = `nb-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          return (
            <section key={group} aria-labelledby={headingId}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <h2 id={headingId} className="font-display text-3xl">
                  {group}
                </h2>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {items.length} · {formatDays(totalDays(items))}
                </span>
              </div>
              {items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
