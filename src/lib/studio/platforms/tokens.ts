import type { PlatformConnection, PrismaClient } from '@prisma/client';
import { PlatformError } from '../../errors';
import {
  decryptSecret,
  encryptSecret,
  tokenContext,
  type DataKeyProvider,
} from '../crypto/envelope';
import type { OAuthClient, OAuthPlatform, TokenSet } from './oauth';

// Access tokens for Studio-owned platform connections (spec 7.12). Tokens are stored envelope-
// encrypted; a token expiring within REFRESH_MARGIN_MS is refreshed first. A refused refresh
// marks the connection needs_reconnect (spec 9.2 "Fail with NEEDS_RECONNECT").

export const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenDeps {
  db: Pick<PrismaClient, 'platformConnection'>;
  keys: DataKeyProvider;
  oauth: (platform: OAuthPlatform) => OAuthClient;
  now: () => number;
}

export async function sealTokens(
  keys: DataKeyProvider,
  organisationId: string,
  platform: string,
  tokens: TokenSet,
) {
  return {
    encryptedAccessToken: await encryptSecret(
      keys,
      tokens.accessToken,
      tokenContext({ organisationId, platform, kind: 'access' }),
    ),
    encryptedRefreshToken: tokens.refreshToken
      ? await encryptSecret(
          keys,
          tokens.refreshToken,
          tokenContext({ organisationId, platform, kind: 'refresh' }),
        )
      : null,
    accessTokenExpiresAt: tokens.expiresAt ?? null,
  };
}

export async function getAccessToken(
  deps: TokenDeps,
  connection: PlatformConnection,
): Promise<string> {
  const platform = connection.platform as OAuthPlatform;
  if (connection.state !== 'active') {
    throw new PlatformError(
      platform,
      'needs_reconnect',
      `${platform} connection is ${connection.state}; reconnect it`,
      false,
    );
  }
  const ctx = { organisationId: connection.organisationId, platform };
  const fresh =
    !connection.accessTokenExpiresAt ||
    connection.accessTokenExpiresAt.getTime() - deps.now() > REFRESH_MARGIN_MS;
  if (fresh)
    return decryptSecret(
      deps.keys,
      connection.encryptedAccessToken,
      tokenContext({ ...ctx, kind: 'access' }),
    );

  if (!connection.encryptedRefreshToken) {
    await markNeedsReconnect(deps, connection.id);
    throw new PlatformError(
      platform,
      'needs_reconnect',
      `${platform} token expired and cannot be refreshed; reconnect`,
      false,
    );
  }
  const refreshToken = await decryptSecret(
    deps.keys,
    connection.encryptedRefreshToken,
    tokenContext({ ...ctx, kind: 'refresh' }),
  );
  let tokens: TokenSet;
  try {
    tokens = await deps.oauth(platform).refresh(refreshToken);
  } catch (err) {
    if (err instanceof PlatformError && err.errorClass === 'needs_reconnect')
      await markNeedsReconnect(deps, connection.id);
    throw err;
  }
  const sealed = await sealTokens(deps.keys, connection.organisationId, platform, {
    ...tokens,
    // Some platforms don't return a new refresh token; keep the current one.
    refreshToken: tokens.refreshToken ?? refreshToken,
  });
  // Compare-and-set on the old ciphertext: if another worker refreshed first, use its token.
  const updated = await deps.db.platformConnection.updateMany({
    where: { id: connection.id, encryptedRefreshToken: connection.encryptedRefreshToken },
    data: sealed,
  });
  if (updated.count === 0) {
    const latest = await deps.db.platformConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    return decryptSecret(
      deps.keys,
      latest.encryptedAccessToken,
      tokenContext({ ...ctx, kind: 'access' }),
    );
  }
  return tokens.accessToken;
}

async function markNeedsReconnect(deps: TokenDeps, id: string): Promise<void> {
  await deps.db.platformConnection.update({ where: { id }, data: { state: 'needs_reconnect' } });
}
