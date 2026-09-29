import { createHash } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { isPasswordBreached } from './breached';

const logger = pino({ level: 'silent' });
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

describe('isPasswordBreached (Phase 18 §5.1, HIBP k-anonymity)', () => {
  it('sends only the first five SHA-1 characters and matches the suffix', async () => {
    const hash = sha1('password123456');
    const fetchImpl = vi.fn(
      async () =>
        new Response(`0000000000000000000000000000000000A:0\r\n${hash.slice(5)}:4213\r\n`),
    );
    await expect(isPasswordBreached('password123456', { logger, fetchImpl })).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
    expect(new Headers(init.headers).get('add-padding')).toBe('true');
  });

  it('is not breached when the suffix is absent or only a zero-count padding line', async () => {
    const hash = sha1('a unique passphrase 991');
    const fetchImpl = vi.fn(async () => new Response(`${hash.slice(5)}:0\nFFFF:3`));
    await expect(
      isPasswordBreached('a unique passphrase 991', { logger, fetchImpl }),
    ).resolves.toBe(false);
  });

  it('fails open (allows the password) when HIBP errors or is unreachable', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await expect(
      isPasswordBreached('x', {
        logger,
        fetchImpl: vi.fn(async () => new Response('', { status: 503 })),
      }),
    ).resolves.toBe(false);
    await expect(
      isPasswordBreached('x', {
        logger,
        fetchImpl: vi.fn(async () => {
          throw new TypeError('network down');
        }),
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('"x"');
  });
});
