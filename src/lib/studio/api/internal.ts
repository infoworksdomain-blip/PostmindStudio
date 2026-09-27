import { createHash, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import {
  NotFoundError,
  PayloadTooLargeError,
  toErrorResponse,
  UnauthorizedError,
  ValidationError,
} from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { reportError } from '../observability/errors';
import { getMetrics, routeLabel } from '../observability/metrics';
import { getApiDeps, type ApiDeps } from './context';
import { jsonResponse, type RouteResult } from './route';

// Service-to-service endpoints under /api/studio/internal/** (Engagement handover 14.13):
// "Called by PostMind core, not by users. Authenticated with X-Service-Token header, not JWT.
// Never exposed publicly — bind to private ingress." Operators MUST route /api/studio/internal/*
// only from the private network (see runbooks/platform-account-revocation.md).
//
//   - STUDIO_INTERNAL_SERVICE_TOKEN unset or shorter than 32 chars → every internal endpoint is a
//     404, as if it did not exist (no configuration, no attack surface).
//   - Missing / wrong X-Service-Token → 401. Compared in constant time (SHA-256 digests of both
//     values, then timingSafeEqual, so neither content nor length leaks through timing).
//   - Bodies are capped at INTERNAL_MAX_BODY_BYTES (413) and requests are rate limited.
//   - Nothing here logs request bodies: they carry access tokens.

export const INTERNAL_TOKEN_MIN_LENGTH = 32;
export const INTERNAL_MAX_BODY_BYTES = 64 * 1024;
export const INTERNAL_ACTOR = 'system:postmind-core';

/** The configured token, or undefined when the internal API is disabled. */
export function configuredServiceToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const token = env.STUDIO_INTERNAL_SERVICE_TOKEN?.trim();
  return token && token.length >= INTERNAL_TOKEN_MIN_LENGTH ? token : undefined;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time comparison of the presented token with the configured one. */
export function serviceTokenMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  return timingSafeEqual(digest(expected), digest(presented));
}

export interface InternalRouteContext {
  req: Request;
  deps: ApiDeps;
  params: Record<string, string>;
  correlationId: string;
  audit: (
    organisationId: string,
    action: string,
    resource: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ) => void;
}

interface NextRouteContext {
  params: Promise<Record<string, string | string[]>>;
}

function flattenParams(params: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]),
  );
}

function authenticate(req: Request): void {
  const expected = configuredServiceToken();
  if (!expected) throw new NotFoundError('Not found');
  if (!serviceTokenMatches(expected, req.headers.get('x-service-token')))
    throw new UnauthorizedError('Missing or invalid X-Service-Token');
}

export function withInternalRoute(handler: (ctx: InternalRouteContext) => Promise<RouteResult>) {
  const handle = async (req: Request, next: NextRouteContext): Promise<Response> => {
    const correlationId = getCorrelationId(req);
    const headers = { 'x-correlation-id': correlationId };
    let log = withContext({ correlationId });
    try {
      authenticate(req);
      const deps = await getApiDeps();
      log = withContext({ correlationId }, deps.logger);
      await deps.internalRateLimiter?.check({
        organisationId: 'internal',
        userId: 'postmind-core',
        method: req.method,
      });
      const result = await handler({
        req,
        deps,
        params: flattenParams((await next?.params) ?? {}),
        correlationId,
        audit: (organisationId, action, resource, metadata) =>
          deps.audit({
            actorUserId: INTERNAL_ACTOR,
            organisationId,
            action,
            resource,
            metadata: { ...metadata, correlationId },
          }),
      });
      return jsonResponse({ ok: true, ...result.body }, { status: result.status ?? 200, headers });
    } catch (err) {
      const response = toErrorResponse(err);
      if (response.status >= 500) {
        log.error({ err }, 'studio internal api error');
        reportError(err, { correlationId, route: new URL(req.url).pathname });
      } else
        log.info(
          { status: response.status, err: (err as Error).message },
          'studio internal request rejected',
        );
      response.headers.set('x-correlation-id', correlationId);
      return response;
    }
  };
  return async function route(req: Request, next: NextRouteContext): Promise<Response> {
    const started = performance.now();
    const response = await handle(req, next);
    getMetrics().httpDuration.observe(
      {
        method: req.method,
        route: routeLabel(new URL(req.url).pathname, (await next?.params) ?? {}),
        status: String(response.status),
      },
      (performance.now() - started) / 1000,
    );
    return response;
  };
}

/** Read a JSON body of at most INTERNAL_MAX_BODY_BYTES and validate it (400 / 413). */
export async function parseInternalBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > INTERNAL_MAX_BODY_BYTES)
    throw new PayloadTooLargeError(`Body exceeds ${INTERNAL_MAX_BODY_BYTES} bytes`);
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > INTERNAL_MAX_BODY_BYTES)
    throw new PayloadTooLargeError(`Body exceeds ${INTERNAL_MAX_BODY_BYTES} bytes`);
  let json: unknown;
  try {
    json = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Paths and messages only: never echo input values (they include access tokens).
    throw new ValidationError('Request body failed validation', {
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
