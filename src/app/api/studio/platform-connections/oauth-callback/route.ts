import { StudioError, toErrorResponse } from '@/lib/errors';
import { getCorrelationId } from '@/lib/logger';
import { studioModes } from '@/lib/mode';
import { getApiDeps } from '@/lib/studio/api/context';
import { selectMetaConnect } from '@/lib/studio/core/select';
import { completeOAuth } from '@/lib/studio/services/connections';

// GET /api/studio/platform-connections/oauth-callback — the platform redirects the browser here.
// There is no JWT on this request: the single-use server-side `state` identifies who started the
// flow (organisation, user, business, PKCE verifier). On success the browser goes back to the
// returnTo URL (same origin only) with ?connected=<platform>; otherwise JSON is returned.
// Phase 18 §2.10: the Meta flow (platform 'meta') also requires the browser's own session to be
// the user who started it, and returns ?connected=meta&count=<accounts connected>.
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const correlationId = getCorrelationId(req);
  const deps = await getApiDeps();
  const url = new URL(req.url);
  try {
    const outcome = await completeOAuth(
      {
        db: deps.db,
        oauth: deps.publishing.oauth,
        oauthState: deps.oauthState,
        keys: deps.publishing.keys,
        meta: deps.metaConnect ?? selectMetaConnect(deps.modes ?? studioModes()),
        currentTenant: () => deps.resolveTenant(req).catch(() => null),
      },
      {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      },
    );
    deps.audit({
      actorUserId: outcome.pending.userId,
      organisationId: outcome.pending.organisationId,
      action: 'studio.connection.connected',
      resource: { type: 'platform_connection', id: outcome.connectionId },
      metadata: {
        platform: outcome.platform,
        correlationId,
        ...(outcome.meta && {
          connectionIds: outcome.meta.connectionIds,
          facebook: outcome.meta.facebook,
          instagram: outcome.meta.instagram,
          skippedPages: outcome.meta.skippedPages,
          scopes: outcome.meta.scopes,
        }),
      },
    });
    if (outcome.pending.returnTo) {
      const back = new URL(outcome.pending.returnTo);
      back.searchParams.set('connected', outcome.platform);
      if (outcome.meta) back.searchParams.set('count', String(outcome.meta.connectionIds.length));
      return Response.redirect(back.toString(), 302);
    }
    return Response.json({
      ok: true,
      connectionId: outcome.connectionId,
      platform: outcome.platform,
      accountName: outcome.accountName,
    });
  } catch (err) {
    const returnTo =
      err instanceof StudioError
        ? (err.details?.pending as { returnTo?: string } | undefined)?.returnTo
        : undefined;
    if (returnTo) {
      const back = new URL(returnTo);
      const reason = err instanceof StudioError ? err.details?.reason : undefined;
      back.searchParams.set(
        'connection_error',
        typeof reason === 'string'
          ? reason
          : err instanceof StudioError
            ? err.code
            : 'internal_error',
      );
      return Response.redirect(back.toString(), 302);
    }
    deps.logger.info({ correlationId, err: (err as Error).message }, 'oauth callback rejected');
    return toErrorResponse(err);
  }
}
