import { NotFoundError, toErrorResponse } from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { studioModes } from '../../mode';
import { reportError } from '../observability/errors';
import {
  parseSignedRequest,
  readSignedRequestBody,
  type MetaSignedRequest,
} from '../platforms/meta-signed-request';
import { getApiDeps, type ApiDeps } from './context';
import { clientAddress, PUBLIC_HEADERS } from './public';
import { jsonResponse } from './route';

// Phase 18 §2.10 / §5.8 — the two server-to-server callbacks Meta sends Studio's app
// (POST /api/meta/deauthorize and POST /api/meta/data-deletion). No session: the signed_request
// HMAC (app secret) is the authentication, verified before anything is read from it. They exist
// only while Studio owns the Meta login (STUDIO_META_CONNECT=studio with META_APP_SECRET set);
// otherwise they answer 404 (in core mode the callbacks belong to Core's app). Rate limited per
// client address with the public limiter.

export interface MetaCallbackContext {
  deps: ApiDeps;
  request: MetaSignedRequest;
  appSecret: string;
  correlationId: string;
}

export function withMetaCallback(
  name: 'deauthorize' | 'data-deletion',
  handler: (
    ctx: MetaCallbackContext,
  ) => Promise<{ status?: number; body: Record<string, unknown> }>,
) {
  return async function route(req: Request): Promise<Response> {
    const correlationId = getCorrelationId(req);
    const headers = { ...PUBLIC_HEADERS, 'x-correlation-id': correlationId };
    let log = withContext({ correlationId }).child({ callback: `meta:${name}` });
    try {
      const deps = await getApiDeps();
      log = withContext({ correlationId }, deps.logger).child({ callback: `meta:${name}` });
      const modes = deps.modes ?? studioModes();
      const appSecret = process.env.META_APP_SECRET?.trim();
      if (modes.metaConnect !== 'studio' || !appSecret) throw new NotFoundError('Not found');
      await deps.publicRateLimiter?.check({
        organisationId: `meta:${name}`,
        userId: clientAddress(req),
        method: req.method,
      });
      const request = parseSignedRequest(await readSignedRequestBody(req), appSecret);
      const result = await handler({ deps, request, appSecret, correlationId });
      return jsonResponse(result.body, { status: result.status ?? 200, headers });
    } catch (err) {
      const response = toErrorResponse(err);
      if (response.status >= 500) {
        log.error({ err }, 'meta callback error');
        reportError(err, { correlationId, route: `meta-${name}` });
      } else
        log.info(
          { status: response.status, err: (err as Error).message },
          'meta callback rejected',
        );
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      return response;
    }
  };
}
