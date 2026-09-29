import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditAction } from '../../src/lib/audit-sink';
import {
  createPrismaIdentityStore,
  createStandaloneIdentityProvider,
  type AuthSessionView,
} from '../../src/lib/identity/standalone';
import {
  createStubEntitlementsReader,
  NO_PLAN_ENTITLEMENTS,
} from '../../src/lib/studio/billing/entitlements-reader';
import {
  cookiesFrom,
  createAuthHarness,
  SESSION_COOKIE,
  setCookieHeader,
  signUpVerified,
  TEST_ORIGIN,
  totpFromUri,
} from '../helpers/auth-harness';

// Phase 18 Track A (§2.3, §5.1–§5.6): Better Auth 1.7.6 over the studio schema, end to end through
// its HTTP handler. Needs DATABASE_URL (PGlite server or Postgres with migrations applied).

const hasDb = Boolean(process.env.DATABASE_URL);
const PASSWORD = 'correct horse battery staple 42';

describe.skipIf(!hasDb)('auth flows (DB)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const h = hasDb
    ? createAuthHarness(db)
    : (undefined as unknown as ReturnType<typeof createAuthHarness>);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('stores the password as argon2id with the OWASP parameters (§5.1)', async () => {
    const email = h.email('hash');
    await signUpVerified(h, email, PASSWORD);
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { accounts: true } });
    const credential = user.accounts.find((a) => a.providerId === 'credential');
    expect(credential?.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.emailVerified).toBe(true);
  });

  it('answers sign-up for a new and an existing address identically (§5.3)', async () => {
    const existing = h.email('dup');
    await signUpVerified(h, existing, PASSWORD);
    const fresh = h.email('fresh');
    const a = await h.call('/sign-up/email', {
      body: { email: fresh, password: PASSWORD, name: 'A' },
      ip: '198.51.100.1',
    });
    const b = await h.call('/sign-up/email', {
      body: { email: existing, password: PASSWORD, name: 'A' },
      ip: '198.51.100.2',
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodyA = (await a.json()) as { user: Record<string, unknown> };
    const bodyB = (await b.json()) as { user: Record<string, unknown> };
    expect(Object.keys(bodyB.user)).toEqual(Object.keys(bodyA.user));
    expect(setCookieHeader(a, SESSION_COOKIE)).toBeUndefined();
    expect(setCookieHeader(b, SESSION_COOKIE)).toBeUndefined();
    expect(h.lastEmail('verifyEmail', fresh).url).toContain('/api/auth/verify-email?token=');
    const sent = h.mailer.sent.find((m) => m.template === 'verifyEmail' && m.to === fresh);
    expect(sent?.options?.idempotencyKey).toMatch(/^auth:verify:[0-9a-f]{32}$/);
    expect(sent?.options?.idempotencyKey).not.toContain(
      new URL(sent?.params.url as string).searchParams.get('token') ?? 'x',
    );
    expect(h.lastEmail('accountExists', existing).signInUrl).toBe('https://studio.test/sign-in');
  });

  it('refuses sign-in until the email is verified (§5.5)', async () => {
    const email = h.email('unverified');
    await h.call('/sign-up/email', { body: { email, password: PASSWORD, name: 'U' } });
    const res = await h.call('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
    expect(setCookieHeader(res, SESSION_COOKIE)).toBeUndefined();
  });

  it('gives one generic failure for a wrong password and an unknown address (§5.3)', async () => {
    const email = h.email('generic');
    await signUpVerified(h, email, PASSWORD);
    const wrong = await h.call('/sign-in/email', {
      body: { email, password: 'wrong password 12345' },
      ip: '192.0.2.50',
    });
    const unknown = await h.call('/sign-in/email', {
      body: { email: h.email('nobody'), password: 'wrong password 12345' },
      ip: '192.0.2.51',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(h.audits.some((a) => a.action === AuditAction.SignInFailed)).toBe(true);
  });

  it('sets an HttpOnly, Secure, SameSite=Lax session cookie and a fresh token (§2.3, §5.4)', async () => {
    const email = h.email('cookie');
    await signUpVerified(h, email, PASSWORD);
    const planted = `${SESSION_COOKIE}=attacker-chosen-token`;
    const res = await h.call('/sign-in/email', {
      body: { email, password: PASSWORD },
      cookies: planted,
      ip: '192.0.2.60',
    });
    expect(res.status).toBe(200);
    const header = setCookieHeader(res, SESSION_COOKIE) ?? '';
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toContain('attacker-chosen-token');
    // The planted token is not a session.
    const session = await h.call('/get-session', { cookies: planted });
    expect(await session.json()).toBeNull();
    const cookies = cookiesFrom(res);
    const mine = (await (await h.call('/get-session', { cookies })).json()) as {
      user: { email: string };
    };
    expect(mine.user.email).toBe(email);
  });

  it('refuses cross-site state changes with a session cookie (§2.3)', async () => {
    const email = h.email('csrf');
    const cookies = await signUpVerified(h, email, PASSWORD);
    const res = await h.call('/update-user', {
      body: { name: 'Evil' },
      cookies,
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.name).toBe('Test User');
  });

  it('rate-limits sign-in per client IP and ignores a spoofed X-Forwarded-For (§5.2)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await h.call('/sign-in/email', {
        body: { email: h.email(`rl${i}`), password: 'wrong password 12345' },
        ip: '192.0.2.99',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    const other = await h.call('/sign-in/email', {
      body: { email: h.email('rl-other'), password: 'wrong password 12345' },
      ip: '192.0.2.100',
    });
    expect(other.status).toBe(401);
  });

  it('rate-limits password reset per address across IPs, answering 200 otherwise (§5.2, §5.3)', async () => {
    const email = h.email('reset-rl');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await h.call('/request-password-reset', {
        body: { email, redirectTo: '/reset-password' },
        ip: `198.18.0.${i + 1}`,
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('resets a password through the emailed link and signs out every session (§5.1)', async () => {
    const email = h.email('reset');
    const cookies = await signUpVerified(h, email, PASSWORD);
    const unknown = await h.call('/request-password-reset', {
      body: { email: h.email('reset-nobody'), redirectTo: '/reset-password' },
      ip: '198.18.1.1',
    });
    const known = await h.call('/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '198.18.1.2',
    });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    const link = new URL(h.lastEmail('resetPassword', email).url);
    const token = link.pathname.split('/').pop() ?? '';
    const reset = await h.call('/reset-password', {
      body: { token, newPassword: 'a brand new passphrase 99' },
      ip: '198.18.1.3',
    });
    expect(reset.status).toBe(200);
    // Past the 60 s cookie cache (§2.3), the session is gone.
    expect(
      await (await h.call('/get-session?disableCookieCache=true', { cookies })).json(),
    ).toBeNull();
    const again = await h.call('/sign-in/email', {
      body: { email, password: 'a brand new passphrase 99' },
      ip: '198.18.1.4',
    });
    expect(again.status).toBe(200);
    expect(h.lastEmail('passwordChanged', email)).toBeDefined();
  });

  it('enrols TOTP, then challenges the next sign-in and accepts the code (§5.6)', async () => {
    const email = h.email('totp');
    let cookies = await signUpVerified(h, email, PASSWORD);
    const enable = await h.call('/two-factor/enable', { body: { password: PASSWORD }, cookies });
    expect(enable.status).toBe(200);
    cookies = cookiesFrom(enable, cookies);
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(backupCodes).toHaveLength(10);
    const stored = await db.twoFactor.findFirstOrThrow({ where: { user: { email } } });
    expect(stored.secret).not.toContain(new URL(totpURI).searchParams.get('secret'));
    expect(stored.backupCodes).not.toContain(backupCodes[0]);
    const verify = await h.call('/two-factor/verify-totp', {
      body: { code: totpFromUri(totpURI) },
      cookies,
    });
    expect(verify.status).toBe(200);

    const signIn = await h.call('/sign-in/email', {
      body: { email, password: PASSWORD },
      ip: '192.0.2.70',
    });
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    expect(setCookieHeader(signIn, SESSION_COOKIE) ?? '').toMatch(/^[^=]+=;/);
    const challenge = cookiesFrom(signIn);
    const second = await h.call('/two-factor/verify-totp', {
      body: { code: totpFromUri(totpURI) },
      cookies: challenge,
      ip: '192.0.2.70',
    });
    expect(second.status).toBe(200);
    expect(setCookieHeader(second, SESSION_COOKIE)).toBeDefined();
    expect(h.audits.some((a) => a.action === AuditAction.TwoFactorEnabled)).toBe(true);
  });

  it('turns 2FA off only with the password AND a current code or a backup code (§5.6)', async () => {
    const ip = '192.0.2.81';
    const email = h.email('totp-off');
    let cookies = await signUpVerified(h, email, PASSWORD);
    const enable = await h.call('/two-factor/enable', {
      body: { password: PASSWORD },
      cookies,
      ip,
    });
    cookies = cookiesFrom(enable, cookies);
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const verify = await h.call('/two-factor/verify-totp', {
      body: { code: totpFromUri(totpURI) },
      cookies,
      ip,
    });
    cookies = cookiesFrom(verify, cookies);

    const passwordOnly = await h.call('/two-factor/disable', {
      body: { password: PASSWORD },
      cookies,
      ip: '192.0.2.82',
    });
    expect(passwordOnly.status).toBe(400);
    expect(await passwordOnly.json()).toMatchObject({ code: 'INVALID_TWO_FACTOR_CODE' });
    const wrongCode = await h.call('/two-factor/disable', {
      body: { password: PASSWORD, code: '000000' === totpFromUri(totpURI) ? '111111' : '000000' },
      cookies,
      ip: '192.0.2.83',
    });
    expect(wrongCode.status).toBe(400);
    expect(await db.user.findFirstOrThrow({ where: { email } })).toMatchObject({
      twoFactorEnabled: true,
    });

    const withBackup = await h.call('/two-factor/disable', {
      body: { password: PASSWORD, code: backupCodes[0] },
      cookies,
      ip: '192.0.2.84',
    });
    expect(withBackup.status).toBe(200);
    expect(await db.user.findFirstOrThrow({ where: { email } })).toMatchObject({
      twoFactorEnabled: false,
    });
    expect(h.audits.some((a) => a.action === AuditAction.TwoFactorDisabled)).toBe(true);
  });
});

describe.skipIf(!hasDb)(
  'account-keyed rate limits against rotating IPs (DB, 19.3)',
  { timeout: 180_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    // Plenty of seats so only the invite rate limit can refuse.
    const h = hasDb
      ? createAuthHarness(db, {
          entitlements: {
            forOrganisation: async () => ({
              ...NO_PLAN_ENTITLEMENTS,
              limits: { ...NO_PLAN_ENTITLEMENTS.limits, seats: 1000 },
            }),
            invalidate: () => undefined,
          },
        })
      : (undefined as unknown as ReturnType<typeof createAuthHarness>);

    afterAll(async () => {
      await db?.$disconnect();
    });

    it('allows 5 second-factor attempts per account in 10 minutes, whatever the IP (§5.2)', async () => {
      const email = h.email('2fa-rl');
      let cookies = await signUpVerified(h, email, PASSWORD);
      const enable = await h.call('/two-factor/enable', { body: { password: PASSWORD }, cookies });
      cookies = cookiesFrom(enable, cookies);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      const good = () => totpFromUri(totpURI);
      const wrong = () => (good() === '000000' ? '111111' : '000000');
      // Attempt 1: the enrolment check (signed in).
      expect(
        (await h.call('/two-factor/verify-totp', { body: { code: good() }, cookies })).status,
      ).toBe(200);

      // Attempts 2-5: wrong codes, each on a fresh sign-in challenge from a new IP (so neither the
      // per-IP rule nor the per-challenge attempt count is what stops the attacker).
      const pending = async (i: number) =>
        cookiesFrom(
          await h.call('/sign-in/email', {
            body: { email, password: PASSWORD },
            ip: `203.0.113.${i}`,
          }),
        );
      for (let i = 2; i <= 5; i += 1) {
        const res = await h.call('/two-factor/verify-totp', {
          body: { code: wrong() },
          cookies: await pending(i),
          ip: `203.0.113.${100 + i}`,
        });
        expect(res.status).toBe(401);
      }
      // Attempt 6, even with the right code and yet another IP: refused.
      const blocked = await h.call('/two-factor/verify-totp', {
        body: { code: good() },
        cookies: await pending(6),
        ip: '203.0.113.200',
      });
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
      expect(setCookieHeader(blocked, SESSION_COOKIE)).toBeUndefined();
      // The backup-code endpoint shares the account budget.
      const backup = await h.call('/two-factor/verify-backup-code', {
        body: { code: 'abcde-fghij' },
        cookies: await pending(7),
        ip: '203.0.113.201',
      });
      expect(backup.status).toBe(429);
    });

    it('caps an organisation at 20 invitations an hour across IPs, without charging strangers (§5.2)', async () => {
      let cookies = await signUpVerified(h, h.email('inviter'), PASSWORD);
      const created = await h.call('/organization/create', {
        body: { name: 'Invite Co', slug: `invite-co-${Date.now()}` },
        cookies,
      });
      cookies = cookiesFrom(created, cookies);
      const { id: organizationId } = (await created.json()) as { id: string };

      // A signed-in stranger naming this organisation is refused and uses none of its budget.
      const stranger = await signUpVerified(h, h.email('stranger'), PASSWORD);
      for (let i = 0; i < 3; i += 1) {
        const res = await h.call('/organization/invite-member', {
          body: { email: h.email(`s${i}`), role: 'viewer', organizationId },
          cookies: stranger,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).not.toBe(429);
      }

      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        const res = await h.call('/organization/invite-member', {
          body: { email: h.email(`inv${i}`), role: 'viewer', organizationId },
          cookies,
          ip: `198.51.100.${i + 1}`,
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses[20]).toBe(429);
      expect(await db.invitation.count({ where: { organizationId } })).toBe(20);

      // Server-side calls (Studio's own invite route) hit the same limit.
      await expect(
        h.auth.api.createInvitation({
          headers: new Headers({ cookie: cookies }),
          body: { email: h.email('inv-server'), role: 'viewer', organizationId },
        }),
      ).rejects.toMatchObject({ statusCode: 429 });
    });

    it('limits verification-email resends per address across IPs (§5.2)', async () => {
      const email = h.email('resend-rl');
      await h.call('/sign-up/email', { body: { email, password: PASSWORD, name: 'R' } });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await h.call('/send-verification-email', {
          body: { email, callbackURL: '/' },
          ip: `198.18.9.${i + 1}`,
        });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      // An unknown address answers the same way (no enumeration).
      const unknown = h.email('resend-nobody');
      const unknownStatuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await h.call('/send-verification-email', {
          body: { email: unknown, callbackURL: '/' },
          ip: `198.18.10.${i + 1}`,
        });
        unknownStatuses.push(res.status);
      }
      expect(unknownStatuses).toEqual(statuses);
    });
  },
);

describe.skipIf(!hasDb)('organisations + standalone identity (DB)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const h = hasDb
    ? createAuthHarness(db)
    : (undefined as unknown as ReturnType<typeof createAuthHarness>);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('creates an organisation owned by its creator and resolves the tenant from the session', async () => {
    const email = h.email('owner');
    let cookies = await signUpVerified(h, email, PASSWORD);
    const created = await h.call('/organization/create', {
      body: {
        name: 'Leeds Sourdough',
        slug: `leeds-${Date.now()}`,
        country: 'GB',
        defaultLocale: 'en-GB',
      },
      cookies,
    });
    expect(created.status).toBe(200);
    cookies = cookiesFrom(created, cookies);
    const org = (await created.json()) as { id: string };
    const row = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(row).toMatchObject({ country: 'GB', defaultLocale: 'en-GB', deletedAt: null });

    const provider = createStandaloneIdentityProvider({
      getSession: async (headers) =>
        (await h.auth.api.getSession({ headers })) as AuthSessionView | null,
      store: createPrismaIdentityStore(db),
      entitlements: createStubEntitlementsReader(),
      appOrigin: TEST_ORIGIN,
    });
    const tenant = await provider.resolve(
      new Request(`${TEST_ORIGIN}/api/studio/projects`, { headers: { cookie: cookies } }),
    );
    expect(tenant).toMatchObject({ organisationId: org.id, role: 'owner', platformRole: 'user' });
    expect(tenant.capabilities).toContain('studio:billing:manage');
    expect(
      h.audits.some((a) => a.action === AuditAction.OrgCreated && a.organisationId === org.id),
    ).toBe(true);
  });

  it('refuses Better Auth organisation deletion (Studio runs its own purge flow)', async () => {
    const cookies = await signUpVerified(h, h.email('nodelete'), PASSWORD);
    const created = await h.call('/organization/create', {
      body: { name: 'Temp', slug: `temp-${Date.now()}` },
      cookies,
    });
    const { id } = (await created.json()) as { id: string };
    const res = await h.call('/organization/delete', {
      body: { organizationId: id },
      cookies: cookiesFrom(created, cookies),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.organization.findUnique({ where: { id } })).not.toBeNull();
  });
});

describe.skipIf(!hasDb)('enumeration timing and Google OAuth (DB)', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const h = hasDb
    ? createAuthHarness(db, {
        google: { clientId: 'google-client', clientSecret: 'google-secret' },
      })
    : (undefined as unknown as ReturnType<typeof createAuthHarness>);

  afterAll(async () => {
    await db?.$disconnect();
  });

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

  it('takes about as long for an unknown address as for a wrong password (§5.3)', async () => {
    const email = h.email('timing');
    await signUpVerified(h, email, PASSWORD);
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      for (const [target, times] of [
        [email, known],
        [h.email(`ghost${i}`), unknown],
      ] as const) {
        const started = performance.now();
        const res = await h.call('/sign-in/email', {
          body: { email: target, password: 'wrong password 12345' },
        });
        times.push(performance.now() - started);
        expect(res.status).toBe(401);
      }
    }
    // Both paths run exactly one argon2id operation; the medians stay within a factor of 2.
    const ratio = median(unknown) / median(known);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('starts Google sign-in with state and PKCE S256, scopes limited to openid email profile (§2.9, §5.9)', async () => {
    const res = await h.call('/sign-in/social', {
      body: { provider: 'google', callbackURL: '/projects' },
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const auth = new URL(url);
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('redirect_uri')).toBe(
      'https://studio.test/api/auth/callback/google',
    );
    expect(auth.searchParams.get('state')?.length).toBeGreaterThanOrEqual(16);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toBeTruthy();
    expect([...new Set(auth.searchParams.get('scope')?.split(' '))].sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
  });

  it('refuses an off-site callbackURL (no open redirect, §5.9)', async () => {
    const res = await h.call('/sign-in/social', {
      body: { provider: 'google', callbackURL: 'https://evil.example/steal' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a callback whose state it did not issue', async () => {
    const res = await h.call('/callback/google?code=x&state=forged-state-value');
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get('location') ?? '').toMatch(/error/);
    expect(setCookieHeader(res, SESSION_COOKIE)).toBeUndefined();
  });
});
