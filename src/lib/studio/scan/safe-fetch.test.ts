import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { ValidationError } from '../../errors';
import { fakeFetch } from '../../../../test/helpers/fake-fetch';
import { assertFetchableUrl, guardedLookup, isPublicAddress, safeGet } from './safe-fetch';

vi.mock('node:dns', () => ({
  lookup: vi.fn(),
}));

describe('isPublicAddress', () => {
  it('returns false for an invalid address string', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('returns false for private IPv4 ranges', () => {
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('172.16.0.1')).toBe(false);
  });

  it('returns false for loopback addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('::1')).toBe(false);
  });

  it('returns false for link-local addresses', () => {
    expect(isPublicAddress('169.254.1.1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
  });

  it('returns false for CGNAT (100.64.0.0/10) addresses', () => {
    expect(isPublicAddress('100.64.0.1')).toBe(false);
  });

  it('returns false for IPv4-mapped IPv6 addresses that unwrap to a non-public address', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
  });

  it('returns true for IPv4-mapped IPv6 addresses that unwrap to a public address', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('returns false for IPv6 unique local addresses (ULA)', () => {
    expect(isPublicAddress('fc00::1')).toBe(false);
  });

  it('returns false for multicast addresses', () => {
    expect(isPublicAddress('224.0.0.1')).toBe(false);
    expect(isPublicAddress('ff02::1')).toBe(false);
  });

  it('returns true for public addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
  });
});

describe('assertFetchableUrl', () => {
  it('returns a parsed URL for an ordinary https URL', () => {
    const url = assertFetchableUrl('https://example.com/path');
    expect(url.hostname).toBe('example.com');
  });

  it('allows explicit default ports 80 and 443', () => {
    // The WHATWG URL parser normalises the default port for the scheme back to "".
    expect(() => assertFetchableUrl('http://example.com:80/')).not.toThrow();
    expect(() => assertFetchableUrl('https://example.com:443/')).not.toThrow();
  });

  it('throws ValidationError for a string that is not a valid URL', () => {
    expect(() => assertFetchableUrl('not a url')).toThrow(ValidationError);
  });

  it('throws ValidationError for non-http(s) schemes', () => {
    expect(() => assertFetchableUrl('ftp://example.com/')).toThrow(ValidationError);
    expect(() => assertFetchableUrl('file:///etc/passwd')).toThrow(ValidationError);
  });

  it('throws ValidationError when the URL carries credentials', () => {
    expect(() => assertFetchableUrl('http://user:pass@example.com/')).toThrow(ValidationError);
  });

  it('throws ValidationError for disallowed ports', () => {
    expect(() => assertFetchableUrl('http://example.com:8080/')).toThrow(ValidationError);
  });

  it('throws ValidationError for an IP-literal host that is not public', () => {
    expect(() => assertFetchableUrl('http://127.0.0.1/')).toThrow(ValidationError);
    expect(() => assertFetchableUrl('http://10.0.0.1/')).toThrow(ValidationError);
    expect(() => assertFetchableUrl('http://[::1]/')).toThrow(ValidationError);
  });

  it('allows an IP-literal host that is public', () => {
    expect(assertFetchableUrl('http://8.8.8.8/').hostname).toBe('8.8.8.8');
  });

  it('throws ValidationError for localhost and its subdomains', () => {
    expect(() => assertFetchableUrl('http://localhost/')).toThrow(ValidationError);
    expect(() => assertFetchableUrl('http://foo.localhost/')).toThrow(ValidationError);
  });

  it('throws ValidationError for .internal hostnames', () => {
    expect(() => assertFetchableUrl('http://service.internal/')).toThrow(ValidationError);
  });

  it('allows an ordinary public hostname', () => {
    expect(assertFetchableUrl('https://example.com/').hostname).toBe('example.com');
  });
});

describe('guardedLookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mockedLookup(): Promise<typeof import('node:dns').lookup> {
    const dns = await import('node:dns');
    return dns.lookup as unknown as typeof import('node:dns').lookup;
  }

  it('resolves with a single public address when options.all is not set', async () => {
    const lookup = await mockedLookup();
    (lookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, [{ address: '8.8.8.8', family: 4 } satisfies LookupAddress]);
      },
    );
    const callback = vi.fn();
    guardedLookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });

  it('resolves with the full list when options.all is set', async () => {
    const lookup = await mockedLookup();
    const addresses: LookupAddress[] = [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ];
    (lookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, addresses);
      },
    );
    const callback = vi.fn();
    guardedLookup('example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, addresses);
  });

  it('refuses with ESSRFBLOCKED when any resolved address is not public', async () => {
    const lookup = await mockedLookup();
    (lookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]);
      },
    );
    const callback = vi.fn();
    guardedLookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    const [err, list] = callback.mock.calls[0] as [NodeJS.ErrnoException, unknown];
    expect(err.code).toBe('ESSRFBLOCKED');
    expect(list).toEqual([]);
  });

  it('refuses when the lookup resolves to an empty address list', async () => {
    const lookup = await mockedLookup();
    (lookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, []);
      },
    );
    const callback = vi.fn();
    guardedLookup('example.com', {}, callback);
    const [err] = callback.mock.calls[0] as [NodeJS.ErrnoException];
    expect(err.code).toBe('ESSRFBLOCKED');
  });

  it('passes through a DNS error unchanged', async () => {
    const lookup = await mockedLookup();
    const dnsError = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    dnsError.code = 'ENOTFOUND';
    (lookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(dnsError, []);
      },
    );
    const callback = vi.fn();
    guardedLookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(dnsError, []);
  });
});

describe('safeGet', () => {
  const options = {
    userAgent: 'test-agent',
    timeoutMs: 5_000,
    maxBytes: 1_000_000,
  };

  it('performs a simple GET and returns the body, status and headers', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const res = await safeGet('https://example.com/page', { ...options, fetchImpl });
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://example.com/page');
    expect(new TextDecoder().decode(res.body)).toBe('hello world');
    expect(res.truncated).toBe(false);
  });

  it('follows a redirect and re-validates the destination', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
      new Response('final', { status: 200 }),
    );
    const res = await safeGet('https://example.com/start', { ...options, fetchImpl });
    expect(res.url).toBe('https://example.com/next');
    expect(new TextDecoder().decode(res.body)).toBe('final');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe('https://example.com/next');
  });

  it('resolves a relative Location header against the current URL', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      new Response(null, { status: 301, headers: { location: '/moved' } }),
      new Response('ok', { status: 200 }),
    );
    await safeGet('https://example.com/start', { ...options, fetchImpl });
    expect(requests[1]?.url).toBe('https://example.com/moved');
  });

  it('refuses a redirect that points at a non-public IP literal', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    );
    await expect(safeGet('https://example.com/start', { ...options, fetchImpl })).rejects.toThrow(
      ValidationError,
    );
  });

  it('throws once redirects exceed maxRedirects', async () => {
    const replies = Array.from(
      { length: 5 },
      (_, i) =>
        new Response(null, {
          status: 302,
          headers: { location: `https://example.com/hop-${i + 1}` },
        }),
    );
    const { fetch: fetchImpl } = fakeFetch(...replies);
    await expect(
      safeGet('https://example.com/start', { ...options, fetchImpl, maxRedirects: 2 }),
    ).rejects.toThrow('Too many redirects');
  });

  it('caps the response body at maxBytes and reports truncated: true', async () => {
    const { fetch: fetchImpl } = fakeFetch(new Response('0123456789', { status: 200 }));
    const res = await safeGet('https://example.com/big', {
      ...options,
      fetchImpl,
      maxBytes: 5,
    });
    expect(res.truncated).toBe(true);
    expect(res.body).toHaveLength(5);
    expect(new TextDecoder().decode(res.body)).toBe('01234');
  });

  it('rejects an unfetchable starting URL before making any request', async () => {
    const { fetch: fetchImpl } = fakeFetch();
    await expect(safeGet('http://127.0.0.1/', { ...options, fetchImpl })).rejects.toThrow(
      ValidationError,
    );
  });
});
