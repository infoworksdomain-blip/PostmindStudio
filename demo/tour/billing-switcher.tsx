import { useEffect, useSyncExternalStore } from 'react';
import { mutate } from 'swr';
import { cn } from '@/lib/utils';
import {
  BILLING_STATE_INFO,
  BILLING_STATES,
  getBillingState,
  isBillingStateId,
  setBillingState,
  subscribeBillingState,
  subscribeUsage,
  type BillingStateId,
} from '../api/billing-state';

// The demo's plan switcher: Trial, Active (Basic / Standard / Plus), Past due, Read-only, No plan,
// Enterprise and Cancelled. It drives the sample API's /me, /billing, /usage and request gate
// (demo/api/billing-state.ts), so the account banner, the billing page, the upgrade dialog and the
// lock badges change as soon as it is switched. Default: Active Standard.

export function useBillingState(): BillingStateId {
  return useSyncExternalStore(subscribeBillingState, getBillingState, getBillingState);
}

/**
 * Re-fetch every screen's data when the plan changes, so the whole page follows it at once. The
 * cache is cleared too (data undefined), not only revalidated: SWR revalidates cached data on
 * mount in an animation frame, which a background tab never runs, so a screen opened later could
 * otherwise show the previous plan.
 */
export function useRevalidateOnBillingChange(): void {
  useEffect(
    () =>
      subscribeBillingState(() => {
        void mutate(() => true, undefined, { revalidate: true });
      }),
    [],
  );
  // A generation or a used credit changes only the usage and billing reads.
  useEffect(
    () =>
      subscribeUsage(() => {
        void mutate(
          (key) =>
            typeof key === 'string' &&
            (key.startsWith('/api/studio/billing') || key.startsWith('/api/studio/usage')),
          undefined,
          { revalidate: true },
        );
      }),
    [],
  );
}

export function BillingSwitcher({ className }: { className?: string }) {
  const state = useBillingState();
  return (
    <label className={cn('flex items-center gap-1.5', className)}>
      <span className="text-background/70">Plan</span>
      <select
        aria-label="Demo plan and billing state"
        value={state}
        onChange={(e) => {
          if (isBillingStateId(e.target.value)) setBillingState(e.target.value);
        }}
        className="h-6 max-w-[9.5rem] rounded border border-background/25 bg-foreground px-1 text-[0.72rem] text-background focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
      >
        {BILLING_STATES.map((id) => (
          <option key={id} value={id}>
            {BILLING_STATE_INFO[id].label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The same switch as a panel of buttons with what each state shows (tour home, feature index). */
export function BillingStatesPanel() {
  const state = useBillingState();
  return (
    <div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {BILLING_STATES.map((id) => {
          const active = id === state;
          const { label, note } = BILLING_STATE_INFO[id];
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setBillingState(id)}
                className={cn(
                  'flex h-full w-full flex-col items-start gap-1 rounded-lg border p-3 text-start text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card hover:border-primary/60',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2 font-medium">
                  {label}
                  {active && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-[0.65rem] font-semibold text-primary-foreground">
                      Now
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{note}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Then open{' '}
        <a className="underline underline-offset-4" href="#/settings/billing">
          Billing
        </a>
        ,{' '}
        <a className="underline underline-offset-4" href="#/projects">
          any app screen
        </a>{' '}
        (the banner) or{' '}
        <a className="underline underline-offset-4" href="#/business">
          Business → Brand
        </a>{' '}
        (lock badges). The choice is kept like the language; “Reset demo” in the bar puts it back to
        Active Standard.
      </p>
    </div>
  );
}
