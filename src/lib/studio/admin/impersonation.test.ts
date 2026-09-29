import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCanImpersonate,
  assertImpersonationAllowsWrite,
  getImpersonationStarter,
  impersonationEnabled,
  impersonationWriteAllowed,
  setImpersonationStarter,
} from './impersonation';

// Phase 18 §2.5 impersonation policy: off by default, read-only when on, never staff.

const on = { STUDIO_IMPERSONATION_ENABLED: 'true' };
const actor = { userId: 'super-1' };
const user = { id: 'u1', role: 'user', banned: false, deletedAt: null };

afterEach(() => setImpersonationStarter(undefined));

describe('impersonation flags', () => {
  it('are off unless exactly true', () => {
    expect(impersonationEnabled({})).toBe(false);
    expect(impersonationEnabled({ STUDIO_IMPERSONATION_ENABLED: '1' })).toBe(false);
    expect(impersonationEnabled(on)).toBe(true);
    expect(impersonationWriteAllowed({})).toBe(false);
    expect(impersonationWriteAllowed({ STUDIO_IMPERSONATION_WRITE: ' TRUE ' })).toBe(true);
  });
});

describe('assertImpersonationAllowsWrite', () => {
  it('lets normal sessions and reads through', () => {
    expect(() => assertImpersonationAllowsWrite({}, 'POST', {})).not.toThrow();
    for (const method of ['GET', 'head', 'OPTIONS'])
      expect(() =>
        assertImpersonationAllowsWrite({ impersonatorUserId: 's' }, method, {}),
      ).not.toThrow();
  });

  it('refuses writes while impersonating unless writes are switched on', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
      expect(() => assertImpersonationAllowsWrite({ impersonatorUserId: 's' }, method, {})).toThrow(
        /read-only/,
      );
    expect(() =>
      assertImpersonationAllowsWrite({ impersonatorUserId: 's' }, 'POST', {
        STUDIO_IMPERSONATION_WRITE: 'true',
      }),
    ).not.toThrow();
  });
});

describe('assertCanImpersonate', () => {
  const reason = (fn: () => void) => {
    try {
      fn();
      return 'ok';
    } catch (err) {
      return (err as { details?: { reason?: string } }).details?.reason ?? (err as Error).name;
    }
  };

  it('checks every rule in order', () => {
    expect(reason(() => assertCanImpersonate(actor, user, {}))).toBe('impersonation_disabled');
    expect(
      reason(() => assertCanImpersonate({ ...actor, impersonatorUserId: 'x' }, user, on)),
    ).toBe('impersonation_nested');
    expect(reason(() => assertCanImpersonate(actor, null, on))).toBe('NotFoundError');
    expect(reason(() => assertCanImpersonate(actor, { ...user, deletedAt: new Date() }, on))).toBe(
      'NotFoundError',
    );
    expect(reason(() => assertCanImpersonate(actor, { ...user, id: 'super-1' }, on))).toBe(
      'impersonation_self',
    );
    for (const role of ['staff', 'superadmin'])
      expect(reason(() => assertCanImpersonate(actor, { ...user, role }, on))).toBe(
        'impersonation_staff',
      );
    expect(reason(() => assertCanImpersonate(actor, { ...user, banned: true }, on))).toBe(
      'impersonation_banned',
    );
    expect(reason(() => assertCanImpersonate(actor, user, on))).toBe('ok');
  });
});

describe('impersonation starter', () => {
  it('answers not implemented until Better Auth installs one', async () => {
    await expect(getImpersonationStarter().start(new Headers(), { userId: 'u1' })).rejects.toThrow(
      /A3/,
    );
    setImpersonationStarter({ start: async () => ({ redirectTo: '/projects' }) });
    await expect(getImpersonationStarter().start(new Headers(), { userId: 'u1' })).resolves.toEqual(
      {
        redirectTo: '/projects',
      },
    );
  });
});
