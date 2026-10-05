import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  changeNowParams,
  createStripeGateway,
  pendingChangeOf,
  schedulePhasesParams,
  toPlanChangePreview,
  toSubscriptionState,
} from './gateway';

// 21.5 — the Stripe shapes the plan changes send and read (docs cited in gateway.ts).

const now = new Date('2026-10-10T12:00:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function phase(
  start: string,
  end: string,
  price: Stripe.SubscriptionSchedule.Phase.Item['price'],
  quantity: number,
  extra: Partial<Stripe.SubscriptionSchedule.Phase> = {},
): Stripe.SubscriptionSchedule.Phase {
  return {
    start_date: sec(start),
    end_date: sec(end),
    items: [{ price, quantity } as Stripe.SubscriptionSchedule.Phase.Item],
    metadata: { organisationId: 'org-1' },
    default_payment_method: null,
    trial_end: null,
    ...extra,
  } as Stripe.SubscriptionSchedule.Phase;
}

function schedule(
  phases: Stripe.SubscriptionSchedule.Phase[],
  status = 'active',
): Stripe.SubscriptionSchedule {
  return {
    id: 'sub_sched_1',
    object: 'subscription_schedule',
    status,
    phases,
    current_phase: phases[0]
      ? { start_date: phases[0].start_date, end_date: phases[0].end_date }
      : null,
  } as unknown as Stripe.SubscriptionSchedule;
}

describe('pendingChangeOf (the next phase of an attached schedule)', () => {
  const monthly = { id: 'price_m', lookup_key: 'studio_channel_monthly' } as Stripe.Price;
  const weekly = { id: 'price_w', lookup_key: 'studio_channel_weekly' } as Stripe.Price;

  it('reads the quantity, price and lookup key starting when the current phase ends', () => {
    const s = schedule([
      phase('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', monthly, 3),
      phase('2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z', weekly, 2),
    ]);
    expect(pendingChangeOf(s, now)).toEqual({
      quantity: 2,
      priceId: 'price_w',
      lookupKey: 'studio_channel_weekly',
      effectiveAt: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('an unexpanded price has no lookup key (reconcile re-fetches it)', () => {
    const s = schedule([
      phase('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 'price_m', 3),
      phase('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 'price_m', 1),
    ]);
    expect(pendingChangeOf(s, now)).toMatchObject({ priceId: 'price_m', lookupKey: null });
  });

  it('no schedule, an id only, a released schedule or no next phase: nothing pending', () => {
    expect(pendingChangeOf(null, now)).toBeNull();
    expect(pendingChangeOf('sub_sched_1', now)).toBeNull();
    const one = [phase('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', monthly, 3)];
    expect(pendingChangeOf(schedule(one), now)).toBeNull();
    expect(pendingChangeOf(schedule(one, 'released'), now)).toBeNull();
  });
});

describe('toSubscriptionState (21.5 fields)', () => {
  it('maps the item, weekly interval, quantity, schedule and pending_update', () => {
    const sub = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      created: sec('2026-10-01T00:00:00Z'),
      cancel_at_period_end: false,
      trial_end: null,
      metadata: {},
      default_payment_method: null,
      pending_update: { expires_at: 1 },
      schedule: schedule([
        phase('2026-10-06T00:00:00Z', '2026-10-13T00:00:00Z', 'price_w', 4),
        phase('2026-10-13T00:00:00Z', '2026-10-20T00:00:00Z', 'price_w', 2),
      ]),
      items: {
        data: [
          {
            id: 'si_1',
            quantity: 4,
            current_period_start: sec('2026-10-06T00:00:00Z'),
            current_period_end: sec('2026-10-13T00:00:00Z'),
            price: {
              id: 'price_w',
              lookup_key: 'studio_channel_weekly',
              unit_amount: 950,
              currency: 'gbp',
              recurring: { interval: 'week' },
              product: 'studio_channel',
            },
          },
        ],
      },
    } as unknown as Stripe.Subscription;
    expect(toSubscriptionState(sub, now)).toMatchObject({
      itemId: 'si_1',
      interval: 'week',
      quantity: 4,
      lookupKey: 'studio_channel_weekly',
      scheduleId: 'sub_sched_1',
      pendingChange: { quantity: 2, effectiveAt: new Date('2026-10-13T00:00:00Z') },
      hasPendingUpdate: true,
    });
  });
});

describe('changeNowParams', () => {
  const change = { subscriptionId: 'sub_1', itemId: 'si_1', priceId: 'price_y', quantity: 3 };

  it('upgrade: always_invoice at the previewed proration time, applied only once paid', () => {
    expect(changeNowParams({ ...change, prorationDate: 1_790_000_000 })).toEqual({
      items: [{ id: 'si_1', price: 'price_y', quantity: 3 }],
      proration_behavior: 'always_invoice',
      proration_date: 1_790_000_000,
      payment_behavior: 'pending_if_incomplete',
    });
  });

  it('trial: no proration (nothing is charged until the trial ends)', () => {
    expect(changeNowParams({ ...change, prorationDate: null })).toEqual({
      items: [{ id: 'si_1', price: 'price_y', quantity: 3 }],
      proration_behavior: 'none',
    });
  });
});

describe('schedulePhasesParams (downgrade at the end of the period)', () => {
  it('keeps the current phase as it is and adds one phase with the new price and quantity', () => {
    const s = schedule([
      phase('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 'price_m', 5, {
        automatic_tax: { enabled: true, disabled_reason: null, liability: null },
        default_payment_method: 'pm_1',
      }),
    ]);
    expect(
      schedulePhasesParams(s, { priceId: 'price_w', quantity: 2, interval: 'week' }, 'org-1'),
    ).toEqual({
      end_behavior: 'release',
      proration_behavior: 'none',
      phases: [
        {
          items: [{ price: 'price_m', quantity: 5 }],
          start_date: sec('2026-10-01T00:00:00Z'),
          end_date: sec('2026-11-01T00:00:00Z'),
          automatic_tax: { enabled: true },
          default_payment_method: 'pm_1',
          metadata: { organisationId: 'org-1' },
        },
        {
          items: [{ price: 'price_w', quantity: 2 }],
          duration: { interval: 'week', interval_count: 1 },
          automatic_tax: { enabled: true },
          default_payment_method: 'pm_1',
          metadata: { organisationId: 'org-1' },
        },
      ],
    });
  });

  it('repeats a trial end so the schedule does not cut the trial short', () => {
    const s = schedule([
      phase('2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', 'price_m', 3, {
        trial_end: sec('2026-10-15T00:00:00Z'),
      }),
    ]);
    const params = schedulePhasesParams(
      s,
      { priceId: 'p', quantity: 1, interval: 'month' },
      'org-1',
    );
    expect(params.phases?.[0]).toMatchObject({ trial_end: sec('2026-10-15T00:00:00Z') });
  });
});

describe('toPlanChangePreview', () => {
  it('amount due now, total, tax and the proration time', () => {
    const inv = {
      amount_due: 1_160,
      total: 1_160,
      currency: 'gbp',
      total_taxes: [{ amount: 193 }],
    } as unknown as Stripe.Invoice;
    expect(toPlanChangePreview(inv, 42)).toEqual({
      amountDuePence: 1_160,
      totalPence: 1_160,
      taxPence: 193,
      currency: 'gbp',
      prorationDate: 42,
    });
    expect(
      toPlanChangePreview({ ...inv, total_taxes: null } as unknown as Stripe.Invoice, 1).taxPence,
    ).toBe(0);
  });
});

describe('listSubscriptions (Stripe expands at most 4 levels)', () => {
  it('lists ids without deep expansion, then retrieves each subscription fully expanded', async () => {
    const depth = (path: string) => path.split('.').length;
    const calls: Array<{ op: string; expand?: string[] }> = [];
    const sub = (id: string) =>
      ({
        id,
        object: 'subscription',
        status: 'active',
        customer: 'cus_1',
        metadata: { organisationId: 'org-1' },
        items: { data: [] },
        schedule: null,
        pending_update: null,
        cancel_at_period_end: false,
      }) as unknown as Stripe.Subscription;
    const fake = {
      subscriptions: {
        list: (params: { expand?: string[] }) => {
          calls.push({ op: 'list', expand: params.expand });
          if ((params.expand ?? []).some((p) => depth(p) > 4))
            throw new Error('property_expansion_max_depth');
          return (async function* () {
            yield sub('sub_1');
            yield sub('sub_2');
          })();
        },
        retrieve: async (id: string, params: { expand?: string[] }) => {
          calls.push({ op: 'retrieve', expand: params.expand });
          if ((params.expand ?? []).some((p) => depth(p) > 4))
            throw new Error('property_expansion_max_depth');
          return sub(id);
        },
      },
    } as unknown as Stripe;
    const ids: string[] = [];
    for await (const s of createStripeGateway(fake).listSubscriptions()) ids.push(s.id);
    expect(ids).toEqual(['sub_1', 'sub_2']);
    expect(calls.filter((c) => c.op === 'retrieve')).toHaveLength(2);
    expect(calls.find((c) => c.op === 'retrieve')?.expand).toContain('items.data.price.product');
  });
});
