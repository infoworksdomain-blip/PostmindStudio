import { z } from 'zod';
import {
  NotFoundError,
  PayloadTooLargeError,
  toErrorResponse,
  UnauthorizedError,
  ValidationError,
} from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { reportError } from '../observability/errors';
import { PROVIDER_ID as SHOTSTACK } from '../providers/shotstack';
import {
  renderCallbackFromEnv,
  verifyRenderCallbackToken,
  type RenderCallbackConfig,
} from '../providers/render-callback';
import { getApiDeps, type ApiDeps } from './context';
import { clientAddress } from './public';
import { jsonResponse } from './route';

// POST /api/studio/webhooks/shotstack?n=…&s=… — BACKLOG 23.1 Shotstack render callback
// (providers/render-callback.ts has the documented contract, read 2026-10-06). Public (Shotstack
// has no session) and authenticated by the per-render token in the query, checked in constant
// time. Shotstack does not sign its payloads, so the payload only names the render: its status
// is fetched from Shotstack's API with the platform key, and only a finished render (done or
// failed) wakes the job waiting for it. The worker then polls once and records the outcome
// exactly as before (provider_jobs, cost, retries), so a replayed callback is harmless:
//   - unknown render (no provider_jobs row)            404
//   - render already recorded (row not RUNNING)        200, nothing fetched or woken
//   - still running at Shotstack (early / forged)      200, not woken
//   - Shotstack unreachable                            502 (Shotstack retries the callback)
// Rate-limited per source address with the other provider webhooks (STUDIO_WEBHOOK_RATE_LIMIT_PER_MIN).

const MAX_BODY_BYTES = 16 * 1024;
const ROUTE = '/api/studio/webhooks/shotstack';

const callbackPayload = z.object({
  type: z.string().max(32).optional(),
  // Shotstack render ids are UUIDs; anything else cannot be one of ours.
  id: z.string().uuid(),
});

export type ShotstackCallbackDeps = Pick<
  ApiDeps,
  'db' | 'registry' | 'providerWake' | 'webhookRateLimiter' | 'logger'
>;

type Env = Readonly<Record<string, string | undefined>>;

let cachedConfig: { env: Env; config: RenderCallbackConfig | undefined } | undefined;

function callbackConfig(env: Env): RenderCallbackConfig | undefined {
  if (cachedConfig?.env !== env) cachedConfig = { env, config: renderCallbackFromEnv(env) };
  return cachedConfig.config;
}

async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new PayloadTooLargeError('Callback body too large');
  const body = await req.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError('Callback body too large');
  }
  return body;
}

function parsePayload(body: string): z.infer<typeof callbackPayload> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ValidationError('Callback body is not JSON');
  }
  const parsed = callbackPayload.safeParse(json);
  if (!parsed.success) throw new ValidationError('Callback body has no render id');
  return parsed.data;
}

export async function handleShotstackCallback(
  req: Request,
  resolveDeps: () => Promise<ShotstackCallbackDeps> = getApiDeps,
  env: Env = process.env,
): Promise<Response> {
  const correlationId = getCorrelationId(req);
  const headers = { 'x-correlation-id': correlationId };
  let log = withContext({ correlationId });
  try {
    const deps = await resolveDeps();
    log = withContext({ correlationId }, deps.logger);
    await deps.webhookRateLimiter?.check({
      organisationId: 'webhook:shotstack',
      userId: clientAddress(req),
      method: 'POST',
    });
    const config = callbackConfig(env);
    const adapter = deps.registry.findAdapter(SHOTSTACK);
    if (!config || !deps.providerWake || !adapter) throw new NotFoundError('Not found');
    const url = new URL(req.url);
    if (
      !verifyRenderCallbackToken(
        config.secret,
        url.searchParams.get('n'),
        url.searchParams.get('s'),
      )
    ) {
      throw new UnauthorizedError('Invalid callback token');
    }
    const payload = parsePayload(await readBody(req));
    // A Serve API ("copy") callback is not a render outcome.
    if (payload.type !== undefined && payload.type !== 'edit') {
      return jsonResponse({ ok: true, ignored: 'not_a_render' }, { headers });
    }
    // RUNNING rows first: the (provider, state) index keeps this to the renders in flight.
    const select = { id: true, state: true, organisationId: true, projectId: true } as const;
    const job =
      (await deps.db.providerJob.findFirst({
        where: { provider: SHOTSTACK, state: 'RUNNING', providerJobId: payload.id },
        select,
      })) ??
      (await deps.db.providerJob.findFirst({
        where: { provider: SHOTSTACK, providerJobId: payload.id },
        select,
      }));
    if (!job) throw new NotFoundError('Unknown render');
    const jobLog = log.child({
      providerJobRowId: job.id,
      organisationId: job.organisationId,
      projectId: job.projectId,
    });
    if (job.state !== 'RUNNING') {
      jobLog.info({ state: job.state }, 'shotstack callback for a recorded render; ignored');
      return jsonResponse({ ok: true, ignored: 'already_recorded' }, { headers });
    }
    // Never trust the payload: ask Shotstack (ProviderError → 502, so Shotstack retries).
    const status = await adapter.poll(payload.id);
    if (status.state === 'running') {
      jobLog.info('shotstack callback but the render is still running; not woken');
      return jsonResponse({ ok: true, ignored: 'still_running' }, { headers });
    }
    await deps.providerWake.signal(SHOTSTACK, payload.id);
    jobLog.info({ state: status.state }, 'shotstack callback: render job woken');
    return jsonResponse({ ok: true, woken: true }, { headers });
  } catch (err) {
    const response = toErrorResponse(err);
    if (response.status >= 500) {
      log.error({ err }, 'shotstack callback error');
      reportError(err, { route: ROUTE });
    } else {
      log.info({ status: response.status }, 'shotstack callback rejected');
    }
    response.headers.set('x-correlation-id', correlationId);
    return response;
  }
}
