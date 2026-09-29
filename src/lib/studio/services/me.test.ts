import { describe, expect, it } from 'vitest';
import { accountBanner } from './me';
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
