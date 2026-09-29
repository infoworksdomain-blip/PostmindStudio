import { describe, expect, it } from 'vitest';
import { accountBanner, cancelledDeletesAt } from './me';
import { getMembershipGateway, setMembershipGateway } from './membership-gateway';

// Phase 18 §3: the AppShell's account-state banner, most urgent first.

const NOW = Date.parse('2026-10-01T12:00:00Z');
const full = { access: 'full' as const, source: 'stripe' as const };

describe('accountBanner', () => {
  it('no entitlements (core mode / tests) → no banner', () => {
    expect(accountBanner(null, null, NOW)).toBeNull();
  });

  it('read-only beats everything', () => {
    expect(
      accountBanner({ ...full, access: 'read_only' }, { status: 'past_due', trialEnd: null }, NOW),
    ).toEqual({ kind: 'read_only' });
  });

  it('read-only after the subscription ended is "cancelled", not "payment overdue" (19.5)', () => {
    const ro = { ...full, access: 'read_only' as const };
    const deletesAt = new Date('2026-12-30T00:00:00Z');
    expect(accountBanner(ro, { status: 'canceled', trialEnd: null }, NOW, deletesAt)).toEqual({
      kind: 'cancelled',
      deletesAt: deletesAt.toISOString(),
    });
    expect(accountBanner(ro, { status: 'incomplete_expired', trialEnd: null }, NOW)).toEqual({
      kind: 'cancelled',
      deletesAt: null,
    });
    expect(accountBanner(ro, null, NOW)).toEqual({ kind: 'cancelled', deletesAt: null });
    expect(accountBanner(ro, { status: 'unpaid', trialEnd: null }, NOW, deletesAt)).toEqual({
      kind: 'read_only',
    });
  });

  it('a cancelled subscription with full access (staff override) shows no cancelled banner', () => {
    expect(accountBanner(full, { status: 'canceled', trialEnd: null }, NOW)).toBeNull();
  });

  it('past due within grace shows the deadline', () => {
    const graceUntil = new Date('2026-10-05T00:00:00Z');
    expect(
      accountBanner({ ...full, graceUntil }, { status: 'past_due', trialEnd: null }, NOW),
    ).toEqual({ kind: 'past_due', graceUntil: graceUntil.toISOString() });
    expect(accountBanner(full, { status: 'past_due', trialEnd: null }, NOW)).toEqual({
      kind: 'past_due',
      graceUntil: null,
    });
  });

  it('no plan asks the organisation to choose one', () => {
    expect(accountBanner({ access: 'none', source: 'none' }, null, NOW)).toEqual({
      kind: 'no_plan',
    });
  });

  it('a running trial shows its end; an ended one shows nothing', () => {
    const trialEnd = new Date('2026-10-10T00:00:00Z');
    expect(
      accountBanner({ ...full, source: 'trial' }, { status: 'trialing', trialEnd }, NOW),
    ).toEqual({ kind: 'trial', endsAt: trialEnd.toISOString() });
    expect(
      accountBanner(full, { status: 'trialing', trialEnd: new Date(NOW - 1) }, NOW),
    ).toBeNull();
  });

  it('an active paid plan has no banner', () => {
    expect(accountBanner(full, { status: 'active', trialEnd: null }, NOW)).toBeNull();
  });
});

describe('cancelledDeletesAt', () => {
  const cancelledAt = '2026-10-01T00:00:00.000Z';
  const clock = { retention: { cancelledAt } };

  it('is the retention clock plus STUDIO_CANCELLED_RETENTION_DAYS (default 90)', () => {
    expect(cancelledDeletesAt(clock, {})?.toISOString()).toBe('2026-12-30T00:00:00.000Z');
    expect(
      cancelledDeletesAt(clock, { STUDIO_CANCELLED_RETENTION_DAYS: '30' })?.toISOString(),
    ).toBe('2026-10-31T00:00:00.000Z');
  });

  it('is unknown without a clock, with retention off, after the purge, or on a bad setting', () => {
    expect(cancelledDeletesAt(null, {})).toBeNull();
    expect(cancelledDeletesAt({}, {})).toBeNull();
    expect(cancelledDeletesAt(clock, { STUDIO_CANCELLED_RETENTION_DAYS: '0' })).toBeNull();
    expect(
      cancelledDeletesAt({ retention: { cancelledAt, purgeRequestedAt: cancelledAt } }, {}),
    ).toBeNull();
    expect(cancelledDeletesAt({ retention: { cancelledAt: 'not a date' } }, {})).toBeNull();
    expect(cancelledDeletesAt(clock, { STUDIO_CANCELLED_RETENTION_DAYS: 'lots' })).toBeNull();
  });
});

describe('membership gateway registry', () => {
  it('core mode has no local membership writes (501)', async () => {
    setMembershipGateway(undefined);
    const gateway = getMembershipGateway({ STUDIO_MODE: 'core' });
    const h = new Headers();
    await expect(
      gateway.createInvitation(h, { organisationId: 'o', email: 'a@b.test', role: 'viewer' }),
    ).rejects.toThrow(/PostMind Core/);
    await expect(gateway.cancelInvitation(h, { invitationId: 'i' })).rejects.toThrow(/Core/);
    await expect(
      gateway.updateMemberRole(h, { organisationId: 'o', memberId: 'm', role: 'admin' }),
    ).rejects.toThrow(/Core/);
    await expect(gateway.removeMember(h, { organisationId: 'o', memberId: 'm' })).rejects.toThrow(
      /Core/,
    );
  });

  it('an installed gateway wins over the mode default', () => {
    const fake = getMembershipGateway({ STUDIO_MODE: 'core' });
    setMembershipGateway(fake);
    expect(getMembershipGateway({})).toBe(fake);
    setMembershipGateway(undefined);
  });
});
