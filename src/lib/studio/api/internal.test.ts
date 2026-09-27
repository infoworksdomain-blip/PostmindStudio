import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PayloadTooLargeError, ValidationError } from '../../errors';
import {
  configuredServiceToken,
  INTERNAL_MAX_BODY_BYTES,
  parseInternalBody,
  serviceTokenMatches,
} from './internal';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const TOKEN = 'a'.repeat(40);

describe('configuredServiceToken', () => {
  it('is undefined (internal API disabled) when unset, blank or shorter than 32 chars', () => {
    expect(configuredServiceToken({})).toBeUndefined();
    expect(configuredServiceToken({ STUDIO_INTERNAL_SERVICE_TOKEN: '   ' })).toBeUndefined();
    expect(
      configuredServiceToken({ STUDIO_INTERNAL_SERVICE_TOKEN: 'x'.repeat(31) }),
    ).toBeUndefined();
  });

  it('returns the trimmed token when it is at least 32 chars', () => {
    expect(configuredServiceToken({ STUDIO_INTERNAL_SERVICE_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
  });
});

describe('serviceTokenMatches', () => {
  it('matches only the exact token', () => {
    expect(serviceTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(serviceTokenMatches(TOKEN, `${TOKEN}b`)).toBe(false);
    expect(serviceTokenMatches(TOKEN, 'short')).toBe(false);
    expect(serviceTokenMatches(TOKEN, '')).toBe(false);
    expect(serviceTokenMatches(TOKEN, null)).toBe(false);
  });

  it('compares fixed-length digests with timingSafeEqual, whatever the presented length', () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    serviceTokenMatches(TOKEN, 'x');
    serviceTokenMatches(TOKEN, 'y'.repeat(500));
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
});

describe('parseInternalBody', () => {
  const schema = z.object({ name: z.string().min(1), secret: z.string().min(10) });
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://studio.test/api/studio/internal/x', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('parses a valid body', async () => {
    await expect(
      parseInternalBody(req(JSON.stringify({ name: 'a', secret: 'abcdefghijk' })), schema),
    ).resolves.toEqual({ name: 'a', secret: 'abcdefghijk' });
  });

  it('rejects a declared or actual body over the limit with 413', async () => {
    await expect(
      parseInternalBody(
        req('{}', { 'content-length': String(INTERNAL_MAX_BODY_BYTES + 1) }),
        schema,
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    const big = JSON.stringify({ name: 'x'.repeat(INTERNAL_MAX_BODY_BYTES), secret: 'y' });
    await expect(parseInternalBody(req(big), schema)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('rejects malformed JSON and schema failures without echoing values', async () => {
    await expect(parseInternalBody(req('{not json'), schema)).rejects.toBeInstanceOf(
      ValidationError,
    );
    const err = await parseInternalBody(
      req(JSON.stringify({ name: '', secret: 'tok-SENSITIVE' })),
      schema,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((err as ValidationError).details)).not.toContain('tok-SENSITIVE');
  });
});
