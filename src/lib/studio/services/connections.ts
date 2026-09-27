import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { DataKeyProvider } from '../crypto/envelope';
import {
  OAUTH_PLATFORMS,
  pkcePair,
  type OAuthClient,
  type OAuthPlatform,
} from '../platforms/oauth';
import type { OAuthPending, OAuthStateStore } from '../platforms/oauth-state';
import { sealTokens } from '../platforms/tokens';

// Platform connections (spec 8.6, BACKLOG 5.8): OAuth for TikTok, YouTube, X and LinkedIn.
// Tokens are envelope-encrypted before they touch the database and never leave the service.

export const oauthInitInput = z.object({
  platform: z.enum(OAUTH_PLATFORMS as [OAuthPlatform, ...OAuthPlatform[]]),
  businessId: z.string().trim().min(1).max(128),
  /** Where to send the browser afterwards; must be under APP_URL. */
  returnTo: z.string().url().max(2_000).optional(),
});

/** Public shape: never includes token ciphertext. */
const PUBLIC_FIELDS = {
  id: true,
  organisationId: true,
  businessId: true,
  platform: true,
  platformAccountId: true,
  platformAccountName: true,
  accessTokenExpiresAt: true,
  scopes: true,
  state: true,
  connectedByUserId: true,
  connectedAt: true,
} as const;

export function listConnections(db: PrismaClient, organisationId: string) {
  return db.platformConnection.findMany({
    where: { organisationId },
    select: PUBLIC_FIELDS,
    orderBy: { connectedAt: 'desc' },
  });
}

/** Only same-origin return URLs are allowed (no open redirect). */
export function safeReturnTo(returnTo: string | undefined, appUrl: string): string | undefined {
  if (!returnTo) return undefined;
  const target = new URL(returnTo);
  const app = new URL(appUrl);
  if (target.origin !== app.origin)
    throw new ValidationError('returnTo must be on the Studio origin');
  return target.toString();
}

export async function startOAuth(
  deps: { oauth: (p: OAuthPlatform) => OAuthClient; oauthState: OAuthStateStore; appUrl: string },
  tenant: TenantContext,
  input: z.infer<typeof oauthInitInput>,
): Promise<{ authorizeUrl: string }> {
  const client = deps.oauth(input.platform);
  const pkce = client.usesPkce ? pkcePair() : undefined;
  const state = await deps.oauthState.create({
    organisationId: tenant.organisationId,
    userId: tenant.userId,
    businessId: input.businessId,
    platform: input.platform,
    ...(pkce && { codeVerifier: pkce.verifier }),
    returnTo: safeReturnTo(input.returnTo, deps.appUrl),
  });
  return { authorizeUrl: client.authorizeUrl({ state, codeChallenge: pkce?.challenge }) };
}

export interface CallbackOutcome {
  pending: OAuthPending;
  connectionId: string;
  platform: OAuthPlatform;
  accountName: string;
}

export async function completeOAuth(
  deps: {
    db: PrismaClient;
    oauth: (p: OAuthPlatform) => OAuthClient;
    oauthState: OAuthStateStore;
    keys: DataKeyProvider;
  },
  query: { code?: string | null; state?: string | null; error?: string | null },
): Promise<CallbackOutcome> {
  if (!query.state) throw new ValidationError('Missing OAuth state');
  const pending = await deps.oauthState.consume(query.state);
  if (!pending)
    throw new ValidationError('OAuth state is unknown, expired or already used; start again');
  if (query.error)
    throw new ValidationError(`The platform returned an error: ${query.error}`, {
      pending: { returnTo: pending.returnTo },
    });
  if (!query.code) throw new ValidationError('Missing OAuth code');

  const client = deps.oauth(pending.platform);
  const tokens = await client.exchangeCode({
    code: query.code,
    codeVerifier: pending.codeVerifier,
  });
  const account = await client.fetchAccount(tokens.accessToken);
  const sealed = await sealTokens(deps.keys, pending.organisationId, pending.platform, tokens);
  const data = {
    businessId: pending.businessId,
    platformAccountName: account.name.slice(0, 200),
    ...sealed,
    scopes: tokens.scopes,
    state: 'active',
    connectedByUserId: pending.userId,
    connectedAt: new Date(),
  };
  const connection = await deps.db.platformConnection.upsert({
    where: {
      organisationId_platform_platformAccountId: {
        organisationId: pending.organisationId,
        platform: pending.platform,
        platformAccountId: account.id,
      },
    },
    create: {
      organisationId: pending.organisationId,
      platform: pending.platform,
      platformAccountId: account.id,
      ...data,
    },
    update: data,
  });
  return {
    pending,
    connectionId: connection.id,
    platform: pending.platform,
    accountName: connection.platformAccountName,
  };
}

/** Disconnect: tokens are wiped (not just flagged) so nothing usable remains at rest. */
export async function disconnect(db: PrismaClient, organisationId: string, id: string) {
  const updated = await db.platformConnection.updateMany({
    where: { id, organisationId },
    data: {
      state: 'revoked',
      encryptedAccessToken: '',
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
    },
  });
  if (updated.count === 0) throw new NotFoundError('Connection not found');
}
