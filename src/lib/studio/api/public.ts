import { createHash } from 'node:crypto';
import { toErrorResponse } from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { reportError } from '../observability/errors';
import { getMetrics, routeLabel } from '../observability/metrics';
import { getApiDeps, type ApiDeps } from './context';
import { jsonResponse, type RouteResult } from './route';

// 15.E5 — the only /api/studio routes that take no PostMind session: public smart-preview share
// links (spec 4.4). Authorisation is the unguessable link token itself (services/share-links.ts).
// Every response is no-store / noindex / no-referrer, so a token never lands in a shared cache, a
// search index or another site's Referer header. Requests are rate limited per client address and
// per link (publicRateLimiter, STUDIO_PUBLIC_RATE_LIMIT_*).

export const PUBLIC_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export interface PublicRouteContext {
  req: Request;
  deps: ApiDeps;
  params: Record<string, string>;
  correlationId: string;
}

interface NextRouteContext {
  params: Promise<Record<string, string | string[]>>;
}

function flattenParams(params: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]),
  );
}

/** The caller's address as the ingress reports it (first X-Forwarded-For hop), else "unknown". */
export function clientAddress(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Rate-limit bucket for a link: a hash prefix, so the token itself never reaches Redis keys. */
export function linkBucket(token: string): string {
  return createHash('sha256').update(`share:${token}`, 'utf8').digest('hex').slice(0, 24);
}

export function withPublicRoute(handler: (ctx: PublicRouteContext) => Promise<RouteResult>) {
  const handle = async (req: Request, next: NextRouteContext): Promise<Response> => {
    const correlationId = getCorrelationId(req);
    const headers = { ...PUBLIC_HEADERS, 'x-correlation-id': correlationId };
    let log = withContext({ correlationId });
    try {
      const deps = await getApiDeps();
      log = withContext({ correlationId }, deps.logger);
      const params = flattenParams((await next?.params) ?? {});
      await deps.publicRateLimiter?.check({
        organisationId: `share:${linkBucket(params.token ?? '')}`,
        userId: clientAddress(req),
        method: req.method,
      });
      const result = await handler({ req, deps, params, correlationId });
      return jsonResponse({ ok: true, ...result.body }, { status: result.status ?? 200, headers });
    } catch (err) {
      const response = toErrorResponse(err);
      if (response.status >= 500) {
        log.error({ err }, 'studio public api error');
        reportError(err, { correlationId, route: 'public-share-link' });
      } else log.info({ status: response.status }, 'studio public request rejected');
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      return response;
    }
  };
  return async function route(req: Request, next: NextRouteContext): Promise<Response> {
    const started = performance.now();
    const response = await handle(req, next);
    getMetrics().httpDuration.observe(
      {
        method: req.method,
        // Never label metrics with the token: routeLabel replaces dynamic params by name.
        route: routeLabel(new URL(req.url).pathname, (await next?.params) ?? {}),
        status: String(response.status),
      },
      (performance.now() - started) / 1000,
    );
    return response;
  };
}
