import type { z } from 'zod';
import { toErrorResponse, ValidationError } from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { requireCapability, type StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import { getApiDeps, type ApiDeps } from './context';
import { idempotencyScope, isValidIdempotencyKey } from './idempotency';

// Every /api/studio route runs through withStudioRoute (CLAUDE.md "API routes"):
//   requireTenantContext → requireCapability → handler, with a correlation id, structured
//   logging, the Engagement error envelope and Idempotency-Key replay for mutations.

export interface RouteContext {
  req: Request;
  tenant: TenantContext;
  deps: ApiDeps;
  params: Record<string, string>;
  correlationId: string;
  /** Audit helper pre-filled with the actor and organisation. */
  audit: (
    action: string,
    resource: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ) => void;
}

export interface RouteResult {
  status?: number;
  body: Record<string, unknown>;
}

type Handler = (ctx: RouteContext) => Promise<RouteResult>;

interface NextRouteContext {
  params: Promise<Record<string, string | string[]>>;
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** JSON response that also serialises BigInt (e.g. video_assets.fileSizeBytes) as strings. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const text = JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(text, { ...init, headers });
}

function flattenParams(params: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]),
  );
}

export function withStudioRoute(capability: StudioCapability, handler: Handler) {
  return async function route(req: Request, next: NextRouteContext): Promise<Response> {
    const correlationId = getCorrelationId(req);
    const headers = { 'x-correlation-id': correlationId };
    let log = withContext({ correlationId });
    try {
      const deps = await getApiDeps();
      log = withContext({ correlationId }, deps.logger);
      const tenant = await deps.resolveTenant(req);
      log = withContext(
        { correlationId, organisationId: tenant.organisationId, userId: tenant.userId },
        deps.logger,
      );
      requireCapability(tenant, capability);

      const path = new URL(req.url).pathname;
      const idemKey = MUTATING.has(req.method) ? req.headers.get('idempotency-key') : null;
      let scope: string | undefined;
      if (idemKey) {
        if (!isValidIdempotencyKey(idemKey))
          throw new ValidationError('Idempotency-Key must be 8–128 URL-safe characters');
        scope = idempotencyScope({
          organisationId: tenant.organisationId,
          userId: tenant.userId,
          method: req.method,
          path,
          key: idemKey,
        });
        const replay = await deps.idempotency.get(scope);
        if (replay) {
          return jsonResponse(replay.body, {
            status: replay.status,
            headers: { ...headers, 'idempotent-replayed': 'true' },
          });
        }
      }

      const params = flattenParams((await next?.params) ?? {});
      const result = await handler({
        req,
        tenant,
        deps,
        params,
        correlationId,
        audit: (action, resource, metadata) =>
          deps.audit({
            actorUserId: tenant.userId,
            organisationId: tenant.organisationId,
            action,
            resource,
            metadata: { ...metadata, correlationId },
          }),
      });
      const status = result.status ?? 200;
      const body = { ok: true, ...result.body };
      const safeBody = JSON.parse(
        JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ) as Record<string, unknown>;
      if (scope && status < 300) await deps.idempotency.set(scope, { status, body: safeBody });
      return jsonResponse(safeBody, { status, headers });
    } catch (err) {
      const response = toErrorResponse(err);
      if (response.status >= 500) log.error({ err }, 'studio api error');
      else
        log.info(
          { status: response.status, err: (err as Error).message },
          'studio api request rejected',
        );
      response.headers.set('x-correlation-id', correlationId);
      return response;
    }
  };
}

/** Parse a JSON body against a zod schema; malformed JSON and schema failures are 400s. */
export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  let json: unknown;
  try {
    const text = await req.text();
    json = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('Request body failed validation', {
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError('Query parameters failed validation', {
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
