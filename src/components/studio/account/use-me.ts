'use client';

import { useApi } from '@/lib/client/api';

// Client view of GET /api/studio/me (src/lib/studio/services/me.ts), shared by the AppShell's
// organisation switcher, user menu and banners, and by the /welcome wizard (no_organisation).

export interface MeOrganisation {
  id: string;
  name: string;
  role: string | null;
}

export type AccountBanner =
  | { kind: 'trial'; endsAt: string }
  | { kind: 'past_due'; graceUntil: string | null }
  | { kind: 'read_only' }
  | { kind: 'cancelled'; deletesAt: string | null }
  | { kind: 'no_plan' };

export interface Me {
  user: { id: string; name: string | null; email: string | null; platformRole: string };
  organisation: MeOrganisation;
  organisations: MeOrganisation[];
  plan: {
    tier: string;
    access: string;
    source: string;
    /** 21.5: the per-channel plan. */
    channels?: number;
    interval?: string;
  } | null;
  /** 21.5: connected platforms past the paid channels (null without a channel plan). */
  channels?: { paid: number; connected: string[]; blocked: string[] } | null;
  banner: AccountBanner | null;
  impersonating: boolean;
  identityMode: 'standalone' | 'core';
  /** The caller's capabilities, as the API checks them (src/lib/rbac.ts). */
  capabilities: string[];
}

export interface MeResponse {
  ok: true;
  me: Me;
}

export const ME_PATH = '/me';

export function useMe() {
  return useApi<MeResponse>(ME_PATH);
}

/** Better Auth endpoints the shell calls directly (same origin; Track A mounts /api/auth/*). */
export const AUTH_SIGN_OUT = '/api/auth/sign-out';
export const AUTH_SET_ACTIVE_ORG = '/api/auth/organization/set-active';

async function postAuth(path: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  return res.ok;
}

export function signOut(): Promise<boolean> {
  return postAuth(AUTH_SIGN_OUT, {});
}

export function setActiveOrganisation(organizationId: string): Promise<boolean> {
  return postAuth(AUTH_SET_ACTIVE_ORG, { organizationId });
}
