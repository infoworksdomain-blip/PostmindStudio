import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { ValidationError } from '../../errors';

// SSRF guard for fetching user-supplied URLs (website scans, scraped images). A scan URL is
// attacker-controlled, so every hop must be a public http(s) address:
//  - only http/https, default ports only, no userinfo;
//  - hostnames are resolved by a guarded DNS lookup INSIDE the connection (so a DNS-rebinding
//    answer cannot slip past a check made earlier), and any non-public address is refused;
//  - redirects are followed manually so each hop is re-validated.

const ALLOWED_PORTS = new Set(['', '80', '443']);

/** True for addresses on the public internet (not private, loopback, link-local, CGNAT, …). */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

/** Parses and checks a URL's shape; throws ValidationError if it is not fetchable. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ValidationError('Only http and https URLs can be scanned');
  if (url.username || url.password) throw new ValidationError('URLs with credentials are refused');
  if (!ALLOWED_PORTS.has(url.port)) throw new ValidationError('Only ports 80 and 443 are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host))
    throw new ValidationError('That address is not on the public internet');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    throw new ValidationError('That address is not on the public internet');
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup wrapper that refuses to connect to non-public addresses. */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const blocked = list.find((a) => !isPublicAddress(a.address));
    if (blocked || list.length === 0) {
      const refusal: NodeJS.ErrnoException = new Error(
        `Refusing to connect to non-public address for ${hostname}`,
      );
      refusal.code = 'ESSRFBLOCKED';
      return callback(refusal, []);
    }
    if (options.all) return callback(null, list);
    const first = list[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

let guardedAgent: Agent | undefined;

/** fetch() whose connections can only reach public addresses. */
export const guardedFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
  guardedAgent ??= new Agent({
    connect: { lookup: guardedLookup as never, timeout: 10_000 },
  });
  return undiciFetch(input as never, { ...(init as object), dispatcher: guardedAgent } as never);
}) as unknown as typeof fetch;

export interface SafeFetchOptions {
  fetchImpl: typeof fetch;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  accept?: string;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
  truncated: boolean;
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

/** GET with manual, re-validated redirects, a hard timeout and a byte cap. */
export async function safeGet(rawUrl: string, options: SafeFetchOptions): Promise<SafeResponse> {
  let url = assertFetchableUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(options.timeoutMs);
  for (let hop = 0; ; hop += 1) {
    const res = await options.fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': options.userAgent,
        accept: options.accept ?? '*/*',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new ValidationError('Too many redirects');
      url = assertFetchableUrl(new URL(res.headers.get('location') as string, url).toString());
      continue;
    }
    const { body, truncated } = await readCapped(res, options.maxBytes);
    return { url: url.toString(), status: res.status, headers: res.headers, body, truncated };
  }
}
