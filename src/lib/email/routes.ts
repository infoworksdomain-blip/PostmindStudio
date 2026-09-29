import { renderUnsubscribePage, type UnsubscribePageState } from '../../emails/unsubscribe-page';
import { PayloadTooLargeError, toErrorResponse, UnauthorizedError } from '../errors';
import { LOCALE_COOKIE, isLocale, resolveLocale, type Locale } from '../i18n/locales';
import { loadMessages } from '../i18n/messages';
import { getCorrelationId, withContext } from '../logger';
import { getApiDeps, type ApiDeps } from '../studio/api/context';
import { clientAddress, PUBLIC_HEADERS } from '../studio/api/public';
import { jsonResponse } from '../studio/api/route';
import { reportError } from '../studio/observability/errors';
import {
  applyUnsubscribe,
  verifyUnsubscribeToken,
  type UnsubscribeClaims,
} from '../studio/notifications/unsubscribe';
import { unsubscribeSecretFromEnv, webhookSecretFromEnv } from './config';
import { PLATFORM_ORGANISATION } from './outbox';
import {
  handleResendEvent,
  MAX_WEBHOOK_BODY_BYTES,
  parseResendEvent,
  verifySvixSignature,
} from './webhook';

// Phase 18 §2.8 — the two public email endpoints (no Studio session; excluded from the sign-in
// middleware like the Stripe webhook):
//   POST /api/email/resend/webhook   Resend delivery events, Svix-signed (webhook.ts)
//   GET|POST /api/email/unsubscribe?token=…   one-click unsubscribe (notifications/unsubscribe.ts)
// Both are rate limited per source address. Neither ever logs a body, a token or an address.

type Env = Record<string, string | undefined>;
type DepsResolver = () => Promise<ApiDeps>;

export const RESEND_ACTOR = 'system:resend';

function errorResponse(err: unknown, log: ReturnType<typeof withContext>, route: string) {
  const response = toErrorResponse(err);
  if (response.status >= 500) {
    log.error({ err }, 'email route error');
    reportError(err, { route });
  } else {
    log.info({ status: response.status }, 'email route request rejected');
  }
  return response;
}

async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_WEBHOOK_BODY_BYTES) throw new PayloadTooLargeError('Webhook body too large');
  const body = await req.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    throw new PayloadTooLargeError('Webhook body too large');
  }
  return body;
}

export async function handleResendWebhook(
  req: Request,
  resolveDeps: DepsResolver = getApiDeps,
  env: Env = process.env,
): Promise<Response> {
  const correlationId = getCorrelationId(req);
  let log = withContext({ correlationId });
  try {
    const deps = await resolveDeps();
    log = withContext({ correlationId }, deps.logger);
    await deps.webhookRateLimiter?.check({
      organisationId: 'webhook:resend',
      userId: clientAddress(req),
      method: 'POST',
    });
    const secret = webhookSecretFromEnv(env);
    const body = await readBody(req);
    try {
      verifySvixSignature(
        secret,
        {
          id: req.headers.get('svix-id'),
          timestamp: req.headers.get('svix-timestamp'),
          signature: req.headers.get('svix-signature'),
        },
        body,
        deps.now(),
      );
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      log.warn({ reason: err.message }, 'resend webhook signature rejected');
      return jsonResponse(
        { ok: false, error: 'invalid_signature', message: 'Invalid webhook signature' },
        { status: 400, headers: { 'x-correlation-id': correlationId } },
      );
    }
    const event = parseResendEvent(body);
    const outcome = await handleResendEvent(deps.db, event);
    for (const s of outcome.suppressed) {
      deps.audit({
        actorUserId: RESEND_ACTOR,
        organisationId: outcome.organisationId ?? PLATFORM_ORGANISATION,
        action: 'studio.email.suppressed',
        resource: { type: 'email_suppression', id: s.addressHash.slice(0, 16) },
        metadata: { reason: s.reason, event: event.type, correlationId },
      });
    }
    log.info(
      { type: event.type, handled: outcome.handled, suppressed: outcome.suppressed.length },
      'resend webhook received',
    );
    return jsonResponse(
      { ok: true, received: true },
      { status: 200, headers: { 'x-correlation-id': correlationId } },
    );
  } catch (err) {
    const response = errorResponse(err, log, '/api/email/resend/webhook');
    response.headers.set('x-correlation-id', correlationId);
    return response;
  }
}

const PAGE_HEADERS: Record<string, string> = {
  ...PUBLIC_HEADERS,
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function cookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function pageLocale(
  deps: ApiDeps,
  req: Request,
  claims: UnsubscribeClaims | null,
): Promise<Locale> {
  if (claims) {
    const user = await deps.db.user.findUnique({
      where: { id: claims.userId },
      select: { locale: true },
    });
    if (isLocale(user?.locale)) return user.locale;
  }
  return resolveLocale({
    cookie: cookie(req, LOCALE_COOKIE),
    acceptLanguage: req.headers.get('accept-language'),
  });
}

async function page(
  deps: ApiDeps,
  req: Request,
  state: UnsubscribePageState,
  claims: UnsubscribeClaims | null,
  status: number,
  action?: string,
): Promise<Response> {
  const locale = await pageLocale(deps, req, claims);
  const html = renderUnsubscribePage({
    state,
    locale,
    messages: await loadMessages(locale),
    ...(claims && { kind: claims.kind }),
    ...(action && { action }),
    appUrl: deps.appUrl,
  });
  return new Response(html, { status, headers: PAGE_HEADERS });
}

/** RFC 8058: a mail client's one-click POST carries this form body. */
function isOneClick(body: string): boolean {
  return new URLSearchParams(body).get('List-Unsubscribe') === 'One-Click';
}

export async function handleUnsubscribe(
  req: Request,
  resolveDeps: DepsResolver = getApiDeps,
  env: Env = process.env,
): Promise<Response> {
  const correlationId = getCorrelationId(req);
  let log = withContext({ correlationId });
  try {
    const deps = await resolveDeps();
    log = withContext({ correlationId }, deps.logger);
    await deps.publicRateLimiter?.check({
      organisationId: 'email:unsubscribe',
      userId: clientAddress(req),
      method: req.method,
    });
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    const claims = verifyUnsubscribeToken(token, unsubscribeSecretFromEnv(env));
    if (!claims) {
      log.info({ method: req.method }, 'unsubscribe link rejected');
      return page(deps, req, 'invalid', null, 400);
    }
    if (req.method === 'GET') {
      // GET never changes anything (link scanners follow links); the page POSTs back.
      const action = `${url.pathname}?token=${encodeURIComponent(token ?? '')}`;
      return page(deps, req, 'confirm', claims, 200, action);
    }
    const body = (await req.text()).slice(0, 1_000);
    await applyUnsubscribe(deps.db, claims);
    deps.audit({
      actorUserId: claims.userId,
      organisationId: claims.organisationId,
      action: 'studio.notification_preferences.unsubscribe',
      resource: { type: 'notification_preferences', id: claims.userId },
      metadata: { kind: claims.kind, oneClick: isOneClick(body), correlationId },
    });
    log.info({ kind: claims.kind, oneClick: isOneClick(body) }, 'email unsubscribed');
    if (isOneClick(body)) {
      return new Response('unsubscribed\n', {
        status: 200,
        headers: { ...PUBLIC_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return page(deps, req, 'done', claims, 200);
  } catch (err) {
    const response = errorResponse(err, log, '/api/email/unsubscribe');
    response.headers.set('x-correlation-id', correlationId);
    return response;
  }
}
