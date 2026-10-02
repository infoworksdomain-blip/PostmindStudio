import { APIError } from 'better-auth/api';
import { ConflictError, ForbiddenError, ValidationError } from '../errors';
import type { StudioAuth } from './config';
import { getAuth } from './server';
import type { CreatedOrganisation, SignedInSession, StandaloneAuthApi } from './session-route';

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

export interface NewOrganisationInput {
  name: string;
  slug: string;
  country: string;
  defaultLocale: string;
}

/**
 * Creates an organisation for the caller and returns the Set-Cookie lines that make it the one the
 * browser's session shows.
 */
export async function createOrganisationActive(
  api: StudioAuth['api'],
  headers: Headers,
  input: NewOrganisationInput,
): Promise<CreatedOrganisation> {
  const { headers: responseHeaders, response } = await api.createOrganization({
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
  // Called server-side, createOrganization changes the session row but sends no cookie, so the
  // browser's cached session (60 s) kept showing the previous organisation. Activating it
  // explicitly returns the refreshed session cookie.
  const activated = await api.setActiveOrganization({
    headers,
    body: { organizationId: response.id },
    returnHeaders: true,
  });
  return {
    organisation: { id: response.id, name: response.name, slug: response.slug },
    setCookies: mergeSetCookies(responseHeaders.getSetCookie(), activated.headers.getSetCookie()),
  };
}

/** Set-Cookie lines with one entry per cookie name; a later line replaces an earlier one. */
function mergeSetCookies(...lists: string[][]): string[] {
  const byName = new Map<string, string>();
  for (const line of lists.flat()) byName.set(line.slice(0, line.indexOf('=')), line);
  return [...byName.values()];
}

export async function betterAuthApi(): Promise<StandaloneAuthApi> {
  const auth = await getAuth();
  return {
    async getSession(headers) {
      return (await auth.api.getSession({ headers })) as SignedInSession | null;
    },
    async createOrganization(headers, input) {
      try {
        return await createOrganisationActive(auth.api, headers, input);
      } catch (err) {
        return mapError(err);
      }
    },
  };
}
