import { APIError } from 'better-auth/api';
import { ForbiddenError, NotFoundError } from '../errors';
import { impersonationEnabled, type ImpersonationStarter } from '../studio/admin/impersonation';

// Phase 18 §2.5 — Track A's Better Auth admin plugin `impersonateUser` behind Track E's
// ImpersonationStarter (studio/admin/impersonation.ts). The admin route has already run the
// policy (off by default, superadmin with 2FA, never staff, reason audited); this creates the
// 30-minute impersonation session (Better Auth stores `impersonatedBy` and keeps the admin's own
// session in the signed `admin_session` cookie) and returns its Set-Cookie headers. The session is
// read-only unless STUDIO_IMPERSONATION_WRITE=true: the standalone IdentityProvider and
// withStudioRoute both refuse writes from it (identity/standalone.ts, assertImpersonationAllowsWrite).
// API: better-auth 1.7.6 dist/plugins/admin/routes.mjs `impersonateUser` (read 2026-09-29).

/** The one Better Auth call the starter needs (tests pass a fake). */
export interface ImpersonateUserApi {
  impersonateUser(input: {
    headers: Headers;
    body: { userId: string };
    returnHeaders: true;
  }): Promise<{ headers: Headers; response: unknown }>;
}

/** Where the staff member lands, now signed in as the user. */
export const IMPERSONATION_LANDING = '/projects';

export function createBetterAuthImpersonationStarter(
  api: ImpersonateUserApi,
  env: Record<string, string | undefined> = process.env,
): ImpersonationStarter {
  return {
    async start(headers, input) {
      // Defence in depth: the flag is checked again here, not only by the route.
      if (!impersonationEnabled(env))
        throw new ForbiddenError('Impersonation is switched off', {
          reason: 'impersonation_disabled',
        });
      try {
        const result = await api.impersonateUser({
          headers,
          body: { userId: input.userId },
          returnHeaders: true,
        });
        return { redirectTo: IMPERSONATION_LANDING, setCookies: result.headers.getSetCookie() };
      } catch (err) {
        if (err instanceof APIError) {
          if (err.statusCode === 404) throw new NotFoundError('User not found');
          if (err.statusCode === 403 || err.statusCode === 401)
            throw new ForbiddenError('Impersonation refused', { reason: 'impersonation_refused' });
        }
        throw err;
      }
    },
  };
}
