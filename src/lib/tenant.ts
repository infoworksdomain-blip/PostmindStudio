import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { requireEnv } from './env';
import { ForbiddenError, UnauthorizedError, UpstreamServiceError } from './errors';
import { logger } from './logger';

// Integration point 2 (Engagement handover 7.3, Studio spec 16.1). The security boundary of
// every /api/studio/* endpoint — it must never fail open:
//   1. Bearer JWT from the Authorization header
//   2. Signature verified against PostMind Core's JWKS (JWKS cached 24h), iss + aud enforced
//   3. Context resolved from Core's /api/internal/context/:userId (cached 5 minutes)
//   4. 401 on missing/invalid token, 403 on missing membership

const JWKS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTEXT_CACHE_MAX_ENTRIES = 10_000;
const UPSTREAM_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_SEC = 5;

// ASSUMED CONTRACT — the specs name the endpoint but not its response body. This schema
// mirrors what the Engagement handover's tenant.ts reads (organisation, memberships,
// capabilities). Anything else fails validation and the request is rejected (502).
const coreContextSchema = z.object({
  organisation: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    planTier: z.string().optional(),
  }),
  memberships: z.array(z.object({ organisationId: z.string().min(1), role: z.string().min(1) })),
  capabilities: z.array(z.string()),
});

export type CoreContext = z.infer<typeof coreContextSchema>;

export interface TenantContext {
  userId: string;
  organisationId: string;
  organisation: CoreContext['organisation'];
  memberships: CoreContext['memberships'];
  capabilities: string[];
}

const claimsSchema = z
  .object({
    sub: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    organisationId: z.string().min(1).optional(),
  })
  .refine((claims) => claims.userId !== undefined || claims.sub !== undefined, {
    message: 'token has no user identifier',
  });

export interface TenantResolverDeps {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  fetchContext: (userId: string) => Promise<CoreContext>;
  now?: () => number;
}

export type TenantResolver = (req: Pick<Request, 'headers'>) => Promise<TenantContext>;

function extractBearerToken(req: Pick<Request, 'headers'>): string {
  const header = req.headers.get('authorization');
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) throw new UnauthorizedError('Missing bearer token');
  return match[1];
}

function isJwksAvailabilityError(err: unknown): boolean {
  return err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid;
}

export function createTenantResolver(deps: TenantResolverDeps): TenantResolver {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { context: CoreContext; expiresAt: number }>();

  async function getContext(userId: string, options: { fresh?: boolean } = {}) {
    const cached = cache.get(userId);
    if (!options.fresh && cached && cached.expiresAt > now()) return cached.context;
    const context = await deps.fetchContext(userId);
    cache.delete(userId);
    if (cache.size >= CONTEXT_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(userId, { context, expiresAt: now() + CONTEXT_CACHE_TTL_MS });
    return context;
  }

  async function verify(token: string): Promise<z.infer<typeof claimsSchema>> {
    try {
      const { payload } = await jwtVerify(token, deps.jwks, {
        issuer: deps.issuer,
        audience: deps.audience,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        currentDate: new Date(now()),
      });
      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) throw new UnauthorizedError('Token claims are invalid');
      return claims.data;
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      if (isJwksAvailabilityError(err)) {
        throw new UpstreamServiceError('Unable to load PostMind JWKS');
      }
      throw new UnauthorizedError('Invalid or expired token');
    }
  }

  return async function resolveTenant(req) {
    const claims = await verify(extractBearerToken(req));
    // Verified above that at least one of userId / sub is present.
    const userId = (claims.userId ?? claims.sub) as string;
    let context = await getContext(userId);
    // The token names an org the cached context doesn't: the user may have switched org in
    // Core within the cache window. Re-read from Core before deciding, never trust stale org.
    if (claims.organisationId && claims.organisationId !== context.organisation.id) {
      context = await getContext(userId, { fresh: true });
    }
    // KNOWN RISK (accepted by spec 16.1's 5-minute cache): capability or membership changes
    // for the same org take up to 5 minutes to apply here.
    const organisationId = claims.organisationId ?? context.organisation.id;

    if (organisationId !== context.organisation.id) {
      throw new ForbiddenError('Token organisation does not match the active organisation');
    }
    if (!context.memberships.some((m) => m.organisationId === organisationId)) {
      throw new ForbiddenError('User is not a member of this organisation');
    }

    return {
      userId,
      organisationId,
      organisation: context.organisation,
      memberships: context.memberships,
      capabilities: context.capabilities,
    };
  };
}

/** Fetch the user's context from PostMind Core with the service token. */
export async function fetchCoreContext(
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoreContext> {
  const baseUrl = requireEnv('POSTMIND_CORE_URL').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/internal/context/${encodeURIComponent(userId)}`, {
      headers: { 'X-Service-Token': requireEnv('POSTMIND_SERVICE_TOKEN') },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamServiceError('PostMind Core context lookup failed');
  }
  if (res.status === 404) throw new ForbiddenError('User is unknown to PostMind Core');
  if (!res.ok) {
    // Upstream status stays in our logs; it is not echoed to API callers.
    logger.warn({ status: res.status }, '[tenant] PostMind Core context lookup failed');
    throw new UpstreamServiceError('PostMind Core context lookup failed');
  }
  const parsed = coreContextSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new UpstreamServiceError('PostMind Core returned an unexpected context shape');
  }
  return parsed.data;
}

let defaultResolver: TenantResolver | undefined;

function getDefaultResolver(): TenantResolver {
  defaultResolver ??= createTenantResolver({
    jwks: createRemoteJWKSet(new URL(requireEnv('POSTMIND_JWKS_URL')), {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      timeoutDuration: UPSTREAM_TIMEOUT_MS,
    }),
    issuer: requireEnv('POSTMIND_JWT_ISSUER'),
    audience: requireEnv('POSTMIND_JWT_AUDIENCE'),
    fetchContext: (userId) => fetchCoreContext(userId),
  });
  return defaultResolver;
}

/** Call first in every /api/studio/* route handler. */
export function requireTenantContext(req: Pick<Request, 'headers'>): Promise<TenantContext> {
  return getDefaultResolver()(req);
}
