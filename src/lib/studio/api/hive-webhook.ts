import { PayloadTooLargeError, toErrorResponse, ValidationError } from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { reportError } from '../observability/errors';
import { recordHiveCallback } from '../pipeline/content-safety-async';
import { getApiDeps, type ApiDeps } from './context';
import { jsonResponse } from './route';

// POST /api/studio/webhooks/hive?token=<per-task token> (BACKLOG 13.25). Called by Hive, not by
// users: no JWT. Hive documents no callback signature, so the unguessable per-task token in the
// URL is the authentication (pipeline/content-safety-async.ts). Unknown tokens → 404. The body
// is Hive's task object (one entry per analysed frame, so long videos are large): capped at
// HIVE_CALLBACK_MAX_BYTES. The token is never logged.

export const HIVE_CALLBACK_MAX_BYTES = 25 * 1024 * 1024;
export const HIVE_ACTOR = 'system:hive';

async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > HIVE_CALLBACK_MAX_BYTES)
    throw new PayloadTooLargeError(`Body exceeds ${HIVE_CALLBACK_MAX_BYTES} bytes`);
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > HIVE_CALLBACK_MAX_BYTES)
    throw new PayloadTooLargeError(`Body exceeds ${HIVE_CALLBACK_MAX_BYTES} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('Callback body must be JSON');
  }
}

export async function handleHiveWebhook(
  req: Request,
  resolveDeps: () => Promise<ApiDeps> = getApiDeps,
): Promise<Response> {
  const correlationId = getCorrelationId(req);
  const headers = { 'x-correlation-id': correlationId };
  let log = withContext({ correlationId });
  try {
    const deps = await resolveDeps();
    log = withContext({ correlationId }, deps.logger);
    const token = new URL(req.url).searchParams.get('token');
    const body = await readJson(req);
    const result = await recordHiveCallback(deps, { token, body });
    deps.audit({
      actorUserId: HIVE_ACTOR,
      organisationId: result.organisationId,
      action: 'studio.content_safety.hive_callback',
      resource: { type: 'content_safety_task', id: result.taskId },
      metadata: { projectId: result.projectId, duplicate: result.duplicate, correlationId },
    });
    log.info(
      { taskId: result.taskId, projectId: result.projectId, duplicate: result.duplicate },
      'hive callback received',
    );
    return jsonResponse({ ok: true, received: true }, { status: 200, headers });
  } catch (err) {
    const response = toErrorResponse(err);
    if (response.status >= 500) {
      log.error({ err }, 'hive webhook error');
      reportError(err, { correlationId, route: '/api/studio/webhooks/hive' });
    } else {
      log.info({ status: response.status }, 'hive webhook rejected');
    }
    response.headers.set('x-correlation-id', correlationId);
    return response;
  }
}
