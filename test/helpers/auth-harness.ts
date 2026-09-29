import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import type { AuditRecord } from '../../src/lib/audit-sink';
import { createAuth, type AuthConfigDeps, type StudioAuth } from '../../src/lib/auth/config';
import { createMemoryAuthRateLimitStore } from '../../src/lib/auth/rate-limit-store';
import { createMemoryAuthMailer } from '../../src/lib/email/auth-mailer';
import { createStubEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';

// Phase 18 Track A: a real Better Auth instance over the test database (PGlite server or Postgres),
// driven through auth.handler() like a browser would (so origin checks, rate limits and cookies
// all apply).

export const TEST_ORIGIN = 'https://studio.test';
export const SESSION_COOKIE = '__Secure-studio.session_token';

export interface AuthHarness {
  auth: StudioAuth;
  mailer: ReturnType<typeof createMemoryAuthMailer>;
  audits: AuditRecord[];
  call: (path: string, init?: CallInit) => Promise<Response>;
  /** Unique address per test run so suites can share one database. */
  email: (label: string) => string;
  lastEmail: (template: string, to: string) => { url: string } & Record<string, unknown>;
}

export interface CallInit {
  method?: string;
  body?: unknown;
  cookies?: string;
  origin?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

export function createAuthHarness(
  db: PrismaClient,
  overrides: Partial<AuthConfigDeps> = {},
): AuthHarness {
  const mailer = createMemoryAuthMailer();
  const audits: AuditRecord[] = [];
  const run = randomUUID().slice(0, 8);
  const auth = createAuth({
    db,
    secret: 'test-secret-that-is-long-enough-0123456789',
    baseURL: TEST_ORIGIN,
    mailer,
    logger: pino({ level: 'silent' }),
    rateLimitStore: createMemoryAuthRateLimitStore(),
    entitlements: createStubEntitlementsReader(),
    audit: async (record) => {
      audits.push(record);
    },
    signupsEnabled: true,
    breachCheck: false,
    trustedProxies: [],
    impersonationEnabled: false,
    secureCookies: true,
    ...overrides,
  });

  // Each call without an explicit ip gets its own client address, so the per-IP limits only
  // bite in the tests that pin one.
  let nextIp = 0;
  const call = (path: string, init: CallInit = {}) => {
    nextIp += 1;
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.origin !== null) headers.set('origin', init.origin ?? TEST_ORIGIN);
    headers.set('x-real-ip', init.ip ?? `10.77.${Math.floor(nextIp / 250) % 250}.${nextIp % 250}`);
    if (init.cookies) headers.set('cookie', init.cookies);
    const url = path.startsWith('http') ? path : `${TEST_ORIGIN}/api/auth${path}`;
    return auth.handler(
      new Request(url, {
        method,
        headers,
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      }),
    );
  };

  return {
    auth,
    mailer,
    audits,
    call,
    email: (label) => `${label}-${run}@example.com`,
    lastEmail(template, to) {
      const found = [...mailer.sent].reverse().find((m) => m.template === template && m.to === to);
      if (!found) throw new Error(`no ${template} email to ${to}`);
      return found.params as { url: string } & Record<string, unknown>;
    },
  };
}

/** name=value pairs from every Set-Cookie header (for the next request's Cookie header). */
export function cookiesFrom(res: Response, previous = ''): string {
  const jar = new Map<string, string>();
  for (const part of previous.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    if (value === '' || /max-age=0/i.test(header)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function setCookieHeader(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from an otpauth:// URI, for 2FA tests. */
export function totpFromUri(uri: string, at = Date.now()): string {
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Sign up, verify through the emailed link and return the signed-in cookies. */
export async function signUpVerified(
  h: AuthHarness,
  email: string,
  password: string,
  name = 'Test User',
): Promise<string> {
  const res = await h.call('/sign-up/email', { body: { email, password, name } });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const { url } = h.lastEmail('verifyEmail', email);
  const verified = await h.call(url);
  if (verified.status >= 400) throw new Error(`verify failed: ${verified.status}`);
  return cookiesFrom(verified);
}
