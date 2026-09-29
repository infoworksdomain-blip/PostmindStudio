import { describe, expect, it } from 'vitest';
import { ConflictError, NotImplementedError, ValidationError } from '../../errors';
import {
  assertMetaConnectAvailable,
  assertSameUser,
  deletionConfirmationCode,
  deletionStatusUrl,
  readDeletionCode,
} from './meta-connect';

// Phase 18 §2.10 — the parts of Studio's Meta connect that need no database (the DB flow is in
// test/api/meta-connect.test.ts).

const SECRET = 'meta-app-secret';

describe('assertMetaConnectAvailable', () => {
  it('is 409 in core mode, 501 until configured, fine otherwise', () => {
    expect(() =>
      assertMetaConnectAvailable({ modes: { metaConnect: 'core' }, configured: true }),
    ).toThrow(ConflictError);
    expect(() =>
      assertMetaConnectAvailable({ modes: { metaConnect: 'studio' }, configured: false }),
    ).toThrow(NotImplementedError);
    expect(() =>
      assertMetaConnectAvailable({ modes: { metaConnect: 'studio' }, configured: true }),
    ).not.toThrow();
  });
});

describe('assertSameUser', () => {
  const pending = { organisationId: 'org-1', userId: 'u1', returnTo: 'https://s.test/connections' };

  it('passes for the user and organisation that started the flow', () => {
    expect(() => assertSameUser(pending, { organisationId: 'org-1', userId: 'u1' })).not.toThrow();
  });

  it.each([
    ['no session', null],
    ['another user', { organisationId: 'org-1', userId: 'u2' }],
    ['another organisation', { organisationId: 'org-2', userId: 'u1' }],
  ])('refuses %s, carrying the return URL and the reason', (_name, current) => {
    try {
      assertSameUser(pending, current);
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toMatchObject({
        reason: 'wrong_user',
        pending: { returnTo: pending.returnTo },
      });
    }
  });
});

describe('data-deletion confirmation codes', () => {
  const at = Date.UTC(2026, 9, 1, 12, 30, 5);

  it('are alphanumeric, round-trip the time and count, and verify', () => {
    const code = deletionConfirmationCode(SECRET, at, 3);
    expect(code).toMatch(/^[0-9a-z]{31}$/);
    expect(readDeletionCode(SECRET, code)).toEqual({
      requestedAt: new Date(Math.floor(at / 1000) * 1000),
      connectionsDeleted: 3,
    });
    expect(readDeletionCode(SECRET, code.toUpperCase())).not.toBeNull();
  });

  it('refuse forged, altered and malformed codes', () => {
    const code = deletionConfirmationCode(SECRET, at, 1);
    expect(readDeletionCode('another-secret', code)).toBeNull();
    const altered = `${code.slice(0, 10)}${code[10] === '2' ? '3' : '2'}${code.slice(11)}`;
    expect(readDeletionCode(SECRET, altered)).toBeNull();
    expect(readDeletionCode(SECRET, 'abc')).toBeNull();
    expect(readDeletionCode(SECRET, `${code}-`)).toBeNull();
  });

  it('builds the status URL on the Studio origin', () => {
    expect(deletionStatusUrl('https://studio.test/', 'abc123')).toBe(
      'https://studio.test/meta/data-deletion?code=abc123',
    );
  });
});
