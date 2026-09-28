import { reportError } from '../observability/errors';
import { getMetrics, routeLabel } from '../observability/metrics';
import type { z } from 'zod';
import { ConflictError, StudioError, toErrorResponse, ValidationError } from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { requireCapability, type StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import { getApiDeps, type ApiDeps } from './context';
import { applyBetaPlan } from '../services/beta';
import { hashBody, idempotencyScope, isValidIdempotencyKey } from './idempotency';

/** 422: an Idempotency-Key reused with a different body (the client has a bug). */
class IdempotencyMismatchError extends StudioError {
  readonly status = 422;
  readonly code = 'idempotency_key_mismatch';
}

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
  const handle = async function handle(req: Request, next: NextRouteContext): Promise<Response> {
    const correlationId = getCorrelationId(req);
    const headers = { 'x-correlation-id': correlationId };
    let log = withContext({ correlationId });
    try {
      const deps = await getApiDeps();
      log = withContext({ correlationId }, deps.logger);
      // BACKLOG 14.11: a beta organisation routes / caps / auto-approves as PLUS (services/beta.ts).
      const tenant = await applyBetaPlan(deps.betaPlans, await deps.resolveTenant(req), deps.now());
      log = withContext(
        { correlationId, organisationId: tenant.organisationId, userId: tenant.userId },
        deps.logger,
      );
      requireCapability(tenant, capability);
      await deps.rateLimiter?.check({
        organisationId: tenant.organisationId,
        userId: tenant.userId,
        method: req.method,
      });

      const path = new URL(req.url).pathname;
      const idemKey = MUTATING.has(req.method) ? req.headers.get('idempotency-key') : null;
      let idem: { scope: string; bodyHash: string } | undefined;
      if (idemKey) {
        if (!isValidIdempotencyKey(idemKey)) {
          throw new ValidationError('Idempotency-Key must be 8–128 URL-safe characters');
        }
        const scope = idempotencyScope({
          organisationId: tenant.organisationId,
          userId: tenant.userId,
          method: req.method,
          path,
          key: idemKey,
        });
        const bodyHash = hashBody(await req.clone().text());
        const claim = await deps.idempotency.reserve(scope, bodyHash);
        if (!claim.reserved) {
          const { existing } = claim;
          if (existing.bodyHash !== bodyHash) {
            throw new IdempotencyMismatchError(
              'Idempotency-Key was already used with a different request body',
            );
          }
          if (existing.state === 'processing') {
            throw new ConflictError('A request with this Idempotency-Key is still in progress');
          }
          return jsonResponse(existing.response.body, {
            status: existing.response.status,
            headers: { ...headers, 'idempotent-replayed': 'true' },
          });
        }
        idem = { scope, bodyHash };
      }

      try {
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
        const safeBody = JSON.parse(
          JSON.stringify({ ok: true, ...result.body }, (_k, v: unknown) =>
            typeof v === 'bigint' ? v.toString() : v,
          ),
        ) as Record<string, unknown>;
        if (idem) {
          if (status < 300)
            await deps.idempotency.complete(idem.scope, idem.bodyHash, { status, body: safeBody });
          else await deps.idempotency.release(idem.scope);
        }
        return jsonResponse(safeBody, { status, headers });
      } catch (err) {
        // A failed request must not pin the key: the client is expected to retry with it.
        if (idem) await deps.idempotency.release(idem.scope).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      const response = toErrorResponse(err);
      if (response.status >= 500) {
        log.error({ err }, 'studio api error');
        reportError(err, { correlationId, route: new URL(req.url).pathname });
      } else
        log.info(
          { status: response.status, err: (err as Error).message },
          'studio api request rejected',
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
