import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError, UpstreamServiceError } from './errors';
import {
  createTenantResolver,
  extractToken,
  fetchCoreContext,
  readCookie,
  type CoreContext,
} from './tenant';

const ISSUER = 'postmind-core';
const AUDIENCE = 'postmind-studio';
const NOW = Date.parse('2026-09-27T12:00:00Z');

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

afterEach(() => vi.unstubAllEnvs());

const context: CoreContext = {
  organisation: { id: 'org-1', name: 'Acme', planTier: 'STANDARD' },
  memberships: [{ organisationId: 'org-1', role: 'owner' }],
  capabilities: ['studio:project:read'],
};

interface TokenOptions {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  key?: CryptoKey;
}

function sign(opts: TokenOptions = {}): Promise<string> {
  return new SignJWT({ userId: 'user-1', organisationId: 'org-1', ...opts.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt(Math.floor(NOW / 1000) - 60)
    .setExpirationTime(opts.expiresAt ?? Math.floor(NOW / 1000) + 900)
    .sign(opts.key ?? privateKey);
}

function request(token?: string): Request {
  return new Request('http://studio/api/studio/projects', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function makeResolver(fetchContext = vi.fn(async () => context), now = () => NOW) {
  return {
    fetchContext,
    resolve: createTenantResolver({ jwks, issuer: ISSUER, audience: AUDIENCE, fetchContext, now }),
  };
}

describe('requireTenantContext (resolver)', () => {
  it('returns the tenant context for a valid token (happy path)', async () => {
    const { resolve, fetchContext } = makeResolver();
    const tenant = await resolve(request(await sign()));
    expect(tenant).toEqual({
      userId: 'user-1',
      organisationId: 'org-1',
      organisation: context.organisation,
      memberships: context.memberships,
      capabilities: ['studio:project:read'],
    });
    expect(fetchContext).toHaveBeenCalledWith('user-1');
  });

  it('falls back to sub and the active organisation when claims omit them', async () => {
    const { resolve } = makeResolver();
    const token = await sign({
      claims: { userId: undefined, organisationId: undefined, sub: 'user-9' },
    });
    const tenant = await resolve(request(token));
    expect(tenant.userId).toBe('user-9');
    expect(tenant.organisationId).toBe('org-1');
  });

  it('rejects a missing token with 401', async () => {
    const { resolve } = makeResolver();
    await expect(resolve(request())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a malformed Authorization header with 401', async () => {
    const { resolve } = makeResolver();
    const req = new Request('http://x', { headers: { authorization: 'Basic abc' } });
    await expect(resolve(req)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an expired token with 401', async () => {
    const { resolve, fetchContext } = makeResolver();
    const token = await sign({ expiresAt: Math.floor(NOW / 1000) - 3600 });
    await expect(resolve(request(token))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(fetchContext).not.toHaveBeenCalled();
  });

  it('rejects the wrong audience with 401', async () => {
    const { resolve } = makeResolver();
    const token = await sign({ audience: 'postmind-engagement' });
    await expect(resolve(request(token))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects the wrong issuer with 401', async () => {
    const { resolve } = makeResolver();
    await expect(resolve(request(await sign({ issuer: 'evil' })))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects a token signed by an unknown key with 401', async () => {
    const { resolve } = makeResolver();
    const token = await sign({ key: otherPrivateKey });
    await expect(resolve(request(token))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an unsigned (alg none) token with 401', async () => {
    const { resolve } = makeResolver();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ userId: 'user-1', iss: ISSUER, aud: AUDIENCE, exp: NOW / 1000 + 900 }),
    ).toString('base64url');
    await expect(resolve(request(`${header}.${body}.`))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token signed with an algorithm other than RS256 (even with a trusted key)', async () => {
    const ec = await generateKeyPair('ES256');
    const ecJwk = { ...(await exportJWK(ec.publicKey)), kid: 'ec1', alg: 'ES256' };
    const resolve = createTenantResolver({
      jwks: createLocalJWKSet({ keys: [ecJwk] }),
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchContext: vi.fn(async () => context),
      now: () => NOW,
    });
    const token = await new SignJWT({ userId: 'user-1', organisationId: 'org-1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'ec1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(NOW / 1000)
      .setExpirationTime(NOW / 1000 + 900)
      .sign(ec.privateKey);
    await expect(resolve(request(token))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token without any user identifier with 401', async () => {
    const { resolve } = makeResolver();
    const token = await sign({ claims: { userId: undefined } });
    await expect(resolve(request(token))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('returns 403 when the token organisation differs from the active one', async () => {
    const { resolve } = makeResolver();
    const token = await sign({ claims: { organisationId: 'org-2' } });
    await expect(resolve(request(token))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns 403 when the user has no membership in the organisation', async () => {
    const { resolve } = makeResolver(vi.fn(async () => ({ ...context, memberships: [] })));
    await expect(resolve(request(await sign()))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('caches the Core context for 5 minutes', async () => {
    let now = NOW;
    const { resolve, fetchContext } = makeResolver(undefined, () => now);
    const token = await sign();
    await resolve(request(token));
    now += 4 * 60 * 1000;
    await resolve(request(token));
    expect(fetchContext).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    await resolve(request(token));
    expect(fetchContext).toHaveBeenCalledTimes(2);
  });

  it('re-reads Core when the token names a different org than the cached context', async () => {
    const org2: CoreContext = {
      organisation: { id: 'org-2' },
      memberships: [{ organisationId: 'org-2', role: 'member' }],
      capabilities: [],
    };
    const fetchContext = vi.fn(async (): Promise<CoreContext> => context);
    const { resolve } = makeResolver(fetchContext);
    await resolve(request(await sign())); // caches org-1
    fetchContext.mockResolvedValueOnce(org2); // user switched org in Core
    const tenant = await resolve(request(await sign({ claims: { organisationId: 'org-2' } })));
    expect(fetchContext).toHaveBeenCalledTimes(2);
    expect(tenant).toMatchObject({ organisationId: 'org-2', capabilities: [] });
  });

  it('still returns 403 when a fresh read confirms the org mismatch', async () => {
    const fetchContext = vi.fn(async (): Promise<CoreContext> => context);
    const { resolve } = makeResolver(fetchContext);
    const token = await sign({ claims: { organisationId: 'org-2' } });
    await expect(resolve(request(token))).rejects.toBeInstanceOf(ForbiddenError);
    expect(fetchContext).toHaveBeenCalledTimes(2);
  });

  it('propagates upstream failures instead of failing open', async () => {
    const failing = vi.fn(async (): Promise<CoreContext> => {
      throw new UpstreamServiceError('down');
    });
    const { resolve } = makeResolver(failing);
    await expect(resolve(request(await sign()))).rejects.toBeInstanceOf(UpstreamServiceError);
  });
});

describe('fetchCoreContext', () => {
  function stubCoreEnv() {
    vi.stubEnv('POSTMIND_CORE_URL', 'http://core.internal/');
    vi.stubEnv('POSTMIND_SERVICE_TOKEN', 'svc-token');
  }

  it('calls Core with the service token and validates the body', async () => {
    stubCoreEnv();
    const fetchImpl = vi.fn(async () => Response.json(context));
    await expect(fetchCoreContext('user/1', fetchImpl)).resolves.toEqual(context);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://core.internal/api/internal/context/user%2F1');
    expect(init.headers).toEqual({ 'X-Service-Token': 'svc-token' });
  });

  it('maps a 404 to 403', async () => {
    stubCoreEnv();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(fetchCoreContext('u', fetchImpl)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('maps other non-2xx responses to an upstream error', async () => {
    stubCoreEnv();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const err = await fetchCoreContext('u', fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamServiceError);
    // The upstream status must not reach API callers.
    expect((err as UpstreamServiceError).details).toBeUndefined();
  });

  it('rejects an unexpected response shape', async () => {
    stubCoreEnv();
    const fetchImpl = vi.fn(async () => Response.json({ organisation: 'nope' }));
    await expect(fetchCoreContext('u', fetchImpl)).rejects.toBeInstanceOf(UpstreamServiceError);
  });

  it('maps network failures to an upstream error', async () => {
    stubCoreEnv();
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchCoreContext('u', fetchImpl)).rejects.toBeInstanceOf(UpstreamServiceError);
  });
});

describe('readCookie', () => {
  it('returns undefined when the header is null', () => {
    expect(readCookie(null, 'session')).toBeUndefined();
  });

  it('returns undefined when the cookie is absent', () => {
    expect(readCookie('a=1; b=2', 'session')).toBeUndefined();
  });

  it('finds the named cookie among several', () => {
    expect(readCookie('a=1; session=abc123; b=2', 'session')).toBe('abc123');
  });

  it('decodes a URL-encoded value', () => {
    expect(readCookie('session=abc%20123', 'session')).toBe('abc 123');
  });

  it('falls back to the raw value when decoding fails', () => {
    expect(readCookie('session=%E0%A4%A', 'session')).toBe('%E0%A4%A');
  });

  it('treats an empty value as absent', () => {
    expect(readCookie('session=', 'session')).toBeUndefined();
  });

  it('does not match a cookie name that is only a suffix of another', () => {
    expect(readCookie('other_session=abc', 'session')).toBeUndefined();
  });
});

describe('extractToken', () => {
  function req(init: { headers?: Record<string, string>; method?: string } = {}) {
    return new Request('http://studio.test/api/studio/projects', {
      method: init.method ?? 'GET',
      headers: init.headers,
    });
  }

  it('prefers the Authorization bearer header over any cookie', () => {
    const token = extractToken(
      req({
        headers: { authorization: 'Bearer header-token', cookie: 'studio_session=cookie-token' },
      }),
      { sessionCookie: 'studio_session' },
    );
    expect(token).toBe('header-token');
  });

  it('throws Unauthorized when there is no header and no sessionCookie configured', () => {
    expect(() => extractToken(req())).toThrow('Missing bearer token');
  });

  it('falls back to the session cookie on a safe GET request', () => {
    const token = extractToken(req({ headers: { cookie: 'studio_session=cookie-token' } }), {
      sessionCookie: 'studio_session',
    });
    expect(token).toBe('cookie-token');
  });

  it('throws Unauthorized when the configured cookie is missing', () => {
    expect(() =>
      extractToken(req({ headers: { cookie: 'other=1' } }), { sessionCookie: 'studio_session' }),
    ).toThrow('Missing bearer token');
  });

  it('allows a cookie-authenticated mutation when Origin matches appOrigin', () => {
    const token = extractToken(
      req({
        method: 'POST',
        headers: { cookie: 'studio_session=cookie-token', origin: 'https://studio.example' },
      }),
      { sessionCookie: 'studio_session', appOrigin: 'https://studio.example' },
    );
    expect(token).toBe('cookie-token');
  });

  it('refuses a cookie-authenticated mutation when Origin does not match appOrigin', () => {
    expect(() =>
      extractToken(
        req({
          method: 'POST',
          headers: { cookie: 'studio_session=cookie-token', origin: 'https://evil.example' },
        }),
        { sessionCookie: 'studio_session', appOrigin: 'https://studio.example' },
      ),
    ).toThrow('Cross-site request refused');
  });

  it('falls back to Sec-Fetch-Site when Origin is absent on a mutation', () => {
    const token = extractToken(
      req({
        method: 'POST',
        headers: { cookie: 'studio_session=cookie-token', 'sec-fetch-site': 'same-origin' },
      }),
      { sessionCookie: 'studio_session', appOrigin: 'https://studio.example' },
    );
    expect(token).toBe('cookie-token');
  });

  it('refuses a mutation with no Origin and a cross-site Sec-Fetch-Site', () => {
    expect(() =>
      extractToken(
        req({
          method: 'POST',
          headers: { cookie: 'studio_session=cookie-token', 'sec-fetch-site': 'cross-site' },
        }),
        { sessionCookie: 'studio_session', appOrigin: 'https://studio.example' },
      ),
    ).toThrow('Cross-site request refused');
  });

  it('refuses a mutation with no Origin, no Sec-Fetch-Site header at all', () => {
    expect(() =>
      extractToken(req({ method: 'POST', headers: { cookie: 'studio_session=cookie-token' } }), {
        sessionCookie: 'studio_session',
        appOrigin: 'https://studio.example',
      }),
    ).toThrow('Cross-site request refused');
  });

  it('does not require the CSRF check for safe methods (GET/HEAD/OPTIONS)', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const token = extractToken(
        req({
          method,
          headers: { cookie: 'studio_session=cookie-token', origin: 'https://evil.example' },
        }),
        { sessionCookie: 'studio_session', appOrigin: 'https://studio.example' },
      );
      expect(token).toBe('cookie-token');
    }
  });
});
