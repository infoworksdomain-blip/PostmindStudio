import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UnauthorizedError, ValidationError } from '../../errors';
import { parseSignedRequest, readSignedRequestBody, signRequest } from './meta-signed-request';

// Phase 18 §5.8 — Meta signed_request verification (deauthorise and data-deletion callbacks).

const SECRET = 'app-secret-under-test';

describe('parseSignedRequest', () => {
  it('accepts a request signed with the app secret and returns the user id', () => {
    const signed = signRequest(
      { algorithm: 'HMAC-SHA256', issued_at: 1_291_836_800, user_id: '218471' },
      SECRET,
    );
    expect(parseSignedRequest(signed, SECRET)).toEqual({
      algorithm: 'HMAC-SHA256',
      issuedAt: 1_291_836_800,
      userId: '218471',
    });
  });

  it('matches Meta’s documented construction (raw HMAC of the encoded payload)', () => {
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 42 })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(parseSignedRequest(`${sig}.${payload}`, SECRET).userId).toBe('42');
  });

  it('reads a Page removal (profile_id)', () => {
    const signed = signRequest({ algorithm: 'HMAC-SHA256', profile_id: '777', user_id: 0 }, SECRET);
    expect(parseSignedRequest(signed, SECRET)).toMatchObject({ profileId: '777' });
  });

  it('rejects a wrong signature with 401 without reading the payload', () => {
    const signed = signRequest({ algorithm: 'HMAC-SHA256', user_id: '1' }, 'another-secret');
    expect(() => parseSignedRequest(signed, SECRET)).toThrow(UnauthorizedError);
  });

  it('rejects a tampered payload', () => {
    const signed = signRequest({ algorithm: 'HMAC-SHA256', user_id: '1' }, SECRET);
    const [sig] = signed.split('.');
    const forged = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '2' })).toString(
      'base64url',
    );
    expect(() => parseSignedRequest(`${sig}.${forged}`, SECRET)).toThrow(UnauthorizedError);
  });

  it.each([
    ['empty', ''],
    ['no dot', 'abc'],
    ['three parts', 'a.b.c'],
    ['bad base64', '!!!.???'],
    ['oversized', `${'a'.repeat(9_000)}.b`],
  ])('rejects malformed input (%s) with 400', (_name, value) => {
    expect(() => parseSignedRequest(value, SECRET)).toThrow(ValidationError);
  });

  it('rejects another algorithm, a non-JSON payload and a request naming nobody', () => {
    expect(() =>
      parseSignedRequest(signRequest({ algorithm: 'HMAC-SHA1', user_id: '1' }, SECRET), SECRET),
    ).toThrow(ValidationError);
    const text = Buffer.from('not json').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(text).digest('base64url');
    expect(() => parseSignedRequest(`${sig}.${text}`, SECRET)).toThrow(ValidationError);
    expect(() =>
      parseSignedRequest(signRequest({ algorithm: 'HMAC-SHA256', user_id: 'x' }, SECRET), SECRET),
    ).toThrow(ValidationError);
  });
});

describe('readSignedRequestBody', () => {
  it('reads the form field Meta posts, and a JSON body', async () => {
    const form = new Request('https://s.test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'signed_request=abc.def',
    });
    expect(await readSignedRequestBody(form)).toBe('abc.def');
    const body = new Request('https://s.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signed_request: 'x.y' }),
    });
    expect(await readSignedRequestBody(body)).toBe('x.y');
  });

  it('answers empty for a missing field and 400 for broken JSON', async () => {
    expect(
      await readSignedRequestBody(new Request('https://s.test', { method: 'POST', body: 'a=b' })),
    ).toBe('');
    await expect(
      readSignedRequestBody(
        new Request('https://s.test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
