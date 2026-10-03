import { describe, expect, it } from 'vitest';
import { planSummary } from './admin-directory';

// 20.27: the Organisations list shows the plan as it applies now and the trial's state.

const now = new Date('2026-10-03T12:00:00Z');
const derived = { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' };
const trial = {
  startedAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-10-15T00:00:00.000Z',
  shortVideos: 5,
  longVideos: 1,
  dailyCostCapPence: 1_000,
  totalCostCapPence: 1_500,
};
const admin = {
  tier: 'PLUS',
  reason: 'ops',
  setByUserId: 'staff-1',
  setAt: '2026-10-02T00:00:00.000Z',
  expiresAt: null,
};

function row(overrides: unknown) {
  return {
    organisationId: 'org-1',
    tier: 'PLUS',
    access: 'full',
    source: 'admin',
    graceUntil: null,
    trialStartedAt: null,
    everPaidAt: null,
    overrides,
    reason: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  } as Parameters<typeof planSummary>[0];
}

describe('planSummary', () => {
  it('no entitlement row: nothing to show', () => {
    expect(planSummary(undefined, now)).toEqual({
      tier: null,
      access: null,
      source: null,
      trial: null,
    });
  });

  it('a running trial, a trial paused by an override, and a trial staff ended', () => {
    expect(planSummary(row({ derived, trial }), now)).toMatchObject({
      tier: 'STANDARD',
      source: 'trial',
      trial: { state: 'running', endsAt: trial.endsAt },
    });
    expect(planSummary(row({ derived, trial, admin }), now)).toMatchObject({
      tier: 'PLUS',
      source: 'admin',
      trial: { state: 'overridden' },
    });
    const ended = { ...trial, endedAt: now.toISOString(), endedByUserId: 'staff-1' };
    expect(planSummary(row({ derived, trial: ended, admin }), now).trial).toEqual({
      state: 'ended',
      endsAt: trial.endsAt,
    });
  });

  it('no trial once Stripe stops trialing', () => {
    const active = { ...derived, source: 'stripe', status: 'active', tier: 'PLUS' };
    expect(planSummary(row({ derived: active, trial }), now)).toMatchObject({
      tier: 'PLUS',
      source: 'stripe',
      trial: null,
    });
  });
});
