import { APIError } from 'better-auth/api';
import { ConflictError, ForbiddenError, ValidationError } from '../errors';
import { getAuth } from './server';
import type { SignedInSession, StandaloneAuthApi } from './session-route';

// Phase 18 Track A: StandaloneAuthApi over the Better Auth instance (auth.api, server-side calls
// with the caller's headers; https://www.better-auth.com/docs/integrations/next "RSC and Server
// actions", read 2026-09-29).

function mapError(err: unknown): never {
  if (err instanceof APIError) {
    const code = (err.body as { code?: string } | undefined)?.code ?? '';
    if (code === 'ORGANIZATION_ALREADY_EXISTS') {
      throw new ConflictError('An organisation with that address already exists');
    }
    if (err.statusCode === 403) throw new ForbiddenError(err.message, { code });
    if (err.statusCode === 400) throw new ValidationError(err.message, { code });
  }
  throw err;
}

export async function betterAuthApi(): Promise<StandaloneAuthApi> {
  const auth = await getAuth();
  return {
    async getSession(headers) {
      return (await auth.api.getSession({ headers })) as SignedInSession | null;
    },
    async createOrganization(headers, input) {
      try {
        const { headers: responseHeaders, response } = await auth.api.createOrganization({
          headers,
          body: {
            name: input.name,
            slug: input.slug,
            country: input.country,
            defaultLocale: input.defaultLocale,
          },
          returnHeaders: true,
        });
        if (!response) throw new ValidationError('Organisation was not created');
        return {
          organisation: { id: response.id, name: response.name, slug: response.slug },
          setCookies: responseHeaders.getSetCookie(),
        };
      } catch (err) {
        return mapError(err);
      }
    },
  };
}
