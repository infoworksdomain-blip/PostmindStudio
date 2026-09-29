import type { Logger } from 'pino';
import { NotFoundError, toErrorResponse, UnauthorizedError } from '../errors';
import { getCorrelationId, logger, withContext } from '../logger';
import { studioModes } from '../mode';
import { assertSameOriginWrite } from '../tenant';

// Phase 18 Track A — routes for a signed-in user who may not have an organisation yet (create
// the first organisation, account security). Standalone mode only (core mode answers 404). The
// Better Auth calls they need sit behind StandaloneAuthApi so tests can drive them without a
// database.

export interface SignedInUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface SignedInSession {
  session: {
    id: string;
    token: string;
    activeOrganizationId?: string | null;
    createdAt?: Date | string;
  };
  user: SignedInUser;
}

export interface CreatedOrganisation {
  organisation: { id: string; name: string; slug: string };
  /** Set-Cookie headers from Better Auth (refreshed session cache with the new active org). */
  setCookies: string[];
}

export interface StandaloneAuthApi {
  getSession(headers: Headers): Promise<SignedInSession | null>;
  createOrganization(
    headers: Headers,
    input: { name: string; slug: string; country: string; defaultLocale: string },
  ): Promise<CreatedOrganisation>;
}

let override: StandaloneAuthApi | undefined;

/** Test hook: install an API (pass undefined to use Better Auth). */
export function setStandaloneAuthApi(api: StandaloneAuthApi | undefined): void {
  override = api;
}

async function authApi(): Promise<StandaloneAuthApi> {
  if (override) return override;
  const { betterAuthApi } = await import('./server-api');
  return betterAuthApi();
}

export interface SignedInRouteContext {
  req: Request;
  params: Record<string, string>;
  session: SignedInSession;
  api: StandaloneAuthApi;
  correlationId: string;
  log: Logger;
}

export interface SignedInResult {
  status?: number;
  body: Record<string, unknown>;
  setCookies?: string[];
}

interface NextRouteContext {
  params: Promise<Record<string, string | string[]>>;
}

export function withSignedInRoute(handler: (ctx: SignedInRouteContext) => Promise<SignedInResult>) {
  return async function route(req: Request, next?: NextRouteContext): Promise<Response> {
    const correlationId = getCorrelationId(req);
    const log = withContext({ correlationId });
    try {
      if (studioModes().identity !== 'standalone') throw new NotFoundError('Not found');
      const api = await authApi();
      const session = await api.getSession(req.headers);
      if (!session) throw new UnauthorizedError('Sign in to continue');
      assertSameOriginWrite(req, new URL(process.env.APP_URL ?? req.url).origin);
      const raw = (await next?.params) ?? {};
      const params = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]),
      );
      const result = await handler({
        req,
        params,
        session,
        api,
        correlationId,
        log: withContext({ correlationId, userId: session.user.id }),
      });
      const headers = new Headers({
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-correlation-id': correlationId,
      });
      for (const cookie of result.setCookies ?? []) headers.append('set-cookie', cookie);
      return new Response(JSON.stringify({ ok: true, ...result.body }), {
        status: result.status ?? 200,
        headers,
      });
    } catch (err) {
      const response = toErrorResponse(err);
      if (response.status >= 500) (log ?? logger).error({ err }, 'signed-in route error');
      response.headers.set('x-correlation-id', correlationId);
      return response;
    }
  };
}
