import { describe, expect, it, vi } from 'vitest';
import {
  applyUnsubscribe,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from './unsubscribe';

// Phase 18 §2.8 — the unsubscribe token only ever turns email off for one (user, org, kind), so
// any change to it must make it invalid.

const SECRET = 'a'.repeat(40);
const CLAIMS = { userId: 'u1', organisationId: 'org-1', kind: 'milestone' as const };

describe('unsubscribe tokens', () => {
  it('round-trips the claims', () => {
    const token = signUnsubscribeToken(CLAIMS, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual(CLAIMS);
    expect(unsubscribeUrl('https://studio.test/', token)).toBe(
      `https://studio.test/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
    );
  });

  it('rejects a tampered payload, a tampered signature and another secret', () => {
    const token = signUnsubscribeToken(CLAIMS, SECRET);
    const [v, payload, sig] = token.split('.') as [string, string, string];
    const otherUser = Buffer.from(JSON.stringify({ u: 'u2', o: 'org-1', k: 'milestone' })).toString(
      'base64url',
    );
    expect(verifyUnsubscribeToken(`${v}.${otherUser}.${sig}`, SECRET)).toBeNull();
    const flipped = `${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyUnsubscribeToken(`${v}.${payload}.${flipped}`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(token, 'b'.repeat(40))).toBeNull();
  });

  it('rejects malformed tokens and unknown kinds', () => {
    expect(verifyUnsubscribeToken(null, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('v2.a.b', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('v1.a.b.c', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(`v1.${'x'.repeat(2000)}.y`, SECRET)).toBeNull();
    const bogus = signUnsubscribeToken({ ...CLAIMS, kind: 'password_reset' as never }, SECRET);
    expect(verifyUnsubscribeToken(bogus, SECRET)).toBeNull();
    const notJson = `v1.${Buffer.from('nope').toString('base64url')}`;
    const forged = signUnsubscribeToken(CLAIMS, SECRET).split('.')[2];
    expect(verifyUnsubscribeToken(`${notJson}.${forged}`, SECRET)).toBeNull();
  });

  it('applyUnsubscribe turns email off for that kind only', async () => {
    const upsert = vi.fn(async () => ({}));
    await applyUnsubscribe({ notificationPreference: { upsert } } as never, CLAIMS);
    expect(upsert).toHaveBeenCalledWith({
      where: {
        organisationId_userId_kind: { organisationId: 'org-1', userId: 'u1', kind: 'milestone' },
      },
      create: { organisationId: 'org-1', userId: 'u1', kind: 'milestone', email: false },
      update: { email: false },
    });
  });
});
