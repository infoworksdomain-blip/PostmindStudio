import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError, UpstreamServiceError } from './errors';
import { createTenantResolver, fetchCoreContext, type CoreContext } from './tenant';

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
    await expect(fetchCoreContext('u', fetchImpl)).rejects.toBeInstanceOf(UpstreamServiceError);
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
