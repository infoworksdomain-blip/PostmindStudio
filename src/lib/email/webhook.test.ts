import { describe, expect, it } from 'vitest';
import { UnauthorizedError, ValidationError } from '../errors';
import { parseResendEvent, signSvix, verifySvixSignature, WEBHOOK_TOLERANCE_S } from './webhook';

// Phase 18 §2.8 — Svix signature verification for the Resend webhook, checked against the
// example published at https://docs.svix.com/receiving/verifying-payloads/how-manual (read
// 2026-09-29).

const SVIX_EXAMPLE = {
  secret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
  payload: '{"event_type":"ping","data":{"success":true}}',
  id: 'msg_loFOjxBNrRLzqYUf',
  timestamp: '1731705121',
  signature: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
};
const AT = Number(SVIX_EXAMPLE.timestamp) * 1000;

function headers(overrides: Partial<Record<'id' | 'timestamp' | 'signature', string | null>> = {}) {
  return {
    id: SVIX_EXAMPLE.id,
    timestamp: SVIX_EXAMPLE.timestamp,
    signature: SVIX_EXAMPLE.signature,
    ...overrides,
  };
}

describe('verifySvixSignature', () => {
  it('reproduces Svix’s published example signature', () => {
    expect(
      signSvix(SVIX_EXAMPLE.secret, SVIX_EXAMPLE.id, SVIX_EXAMPLE.timestamp, SVIX_EXAMPLE.payload),
    ).toBe(SVIX_EXAMPLE.signature);
    expect(() =>
      verifySvixSignature(SVIX_EXAMPLE.secret, headers(), SVIX_EXAMPLE.payload, AT),
    ).not.toThrow();
  });

  it('accepts any matching v1 entry in a space-separated list', () => {
    const list = `v1,bm9ldHUjKzFob2VudXRob2VodWUzMjRvdWVvdW9ldQo= ${SVIX_EXAMPLE.signature} v2,abc`;
    expect(() =>
      verifySvixSignature(
        SVIX_EXAMPLE.secret,
        headers({ signature: list }),
        SVIX_EXAMPLE.payload,
        AT,
      ),
    ).not.toThrow();
  });

  it('rejects a changed body, another secret, and a forged signature', () => {
    const cases: Array<[string, ReturnType<typeof headers>, string]> = [
      [SVIX_EXAMPLE.secret, headers(), `${SVIX_EXAMPLE.payload} `],
      ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', headers(), SVIX_EXAMPLE.payload],
      [SVIX_EXAMPLE.secret, headers({ signature: 'v1,AAAA' }), SVIX_EXAMPLE.payload],
      [SVIX_EXAMPLE.secret, headers({ signature: 'v2,rAvfW3dJ' }), SVIX_EXAMPLE.payload],
      [SVIX_EXAMPLE.secret, headers({ id: 'msg_other' }), SVIX_EXAMPLE.payload],
    ];
    for (const [secret, h, body] of cases) {
      expect(() => verifySvixSignature(secret, h, body, AT)).toThrow(UnauthorizedError);
    }
  });

  it('rejects stale, future and malformed timestamps and missing headers', () => {
    const late = AT + (WEBHOOK_TOLERANCE_S + 1) * 1000;
    const early = AT - (WEBHOOK_TOLERANCE_S + 1) * 1000;
    expect(() =>
      verifySvixSignature(SVIX_EXAMPLE.secret, headers(), SVIX_EXAMPLE.payload, late),
    ).toThrow(/tolerance/);
    expect(() =>
      verifySvixSignature(SVIX_EXAMPLE.secret, headers(), SVIX_EXAMPLE.payload, early),
    ).toThrow(/tolerance/);
    expect(() =>
      verifySvixSignature(
        SVIX_EXAMPLE.secret,
        headers({ timestamp: '17e8' }),
        SVIX_EXAMPLE.payload,
        AT,
      ),
    ).toThrow(/timestamp/);
    for (const missing of ['id', 'timestamp', 'signature'] as const) {
      expect(() =>
        verifySvixSignature(
          SVIX_EXAMPLE.secret,
          headers({ [missing]: null }),
          SVIX_EXAMPLE.payload,
          AT,
        ),
      ).toThrow(/Missing/);
    }
  });
});

describe('parseResendEvent', () => {
  it('reads the documented bounce payload', () => {
    const event = parseResendEvent(
      JSON.stringify({
        type: 'email.bounced',
        created_at: '2026-11-22T23:41:12.126Z',
        data: {
          email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
          to: ['delivered@resend.dev', 42],
          bounce: { message: 'm', subType: 'Suppressed', type: 'Permanent' },
        },
      }),
    );
    expect(event).toEqual({
      type: 'email.bounced',
      data: {
        email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
        to: ['delivered@resend.dev'],
        bounce: { message: 'm', subType: 'Suppressed', type: 'Permanent' },
      },
    });
  });

  it('rejects bodies that are not Resend events', () => {
    expect(() => parseResendEvent('not json')).toThrow(ValidationError);
    expect(() => parseResendEvent('{"data":{}}')).toThrow(ValidationError);
    expect(() => parseResendEvent('{"type":"email.sent"}')).toThrow(ValidationError);
  });
});
