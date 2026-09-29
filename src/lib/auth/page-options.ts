import { headers } from 'next/headers';
import { studioModes } from '../mode';
import { safeNextPath } from './page-guard';

// Phase 18 Track A — what the sign-in pages (server components) need from env and the request.

export function authPageOptions(env: Record<string, string | undefined> = process.env) {
  return {
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()),
    signupsEnabled: env.STUDIO_SIGNUPS_ENABLED?.trim() !== 'false',
    standalone: studioModes(env).identity === 'standalone',
    supportEmail: env.STUDIO_SUPPORT_EMAIL?.trim() || undefined,
  };
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function param(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function nextParam(
  params: Record<string, string | string[] | undefined>,
  fallback?: string,
) {
  return safeNextPath(param(params, 'next'), fallback);
}

/** The signed-in user id from the Better Auth session, or null (also null in core mode). */
export async function currentUserId(): Promise<string | null> {
  if (!authPageOptions().standalone) return null;
  const { getAuth } = await import('./server');
  const session = await (await getAuth()).api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}
