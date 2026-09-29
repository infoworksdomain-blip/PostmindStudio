import type { PlatformConnection, PrismaClient } from '@prisma/client';
import { PlatformError } from '../../errors';
import { decryptSecret, tokenContext, type DataKeyProvider } from '../crypto/envelope';
import type { MetaAccountRef, MetaCredentialSource, MetaCredentials } from './meta';

// Meta credentials from the channels PostMind Core registered through
// /api/studio/internal/channels (services/meta-channels.ts). Studio never refreshes Meta tokens
// itself: Core's nightly job pushes refreshed tokens (Engagement handover 9.6 / 14.13). A token
// that has expired, or that Meta refuses with error 190, marks the connection needs_reconnect —
// the user reconnects in PostMind settings and Core registers the channel again.
// Phase 18 §2.10: with STUDIO_META_CONNECT=studio the same rows are written by Studio's own
// Facebook Login for Business (services/meta-connect.ts); the Page tokens it stores do not
// expire, and the reconnect happens on Studio's Connections page. The message's where-to-go
// follows `reconnectIn` (chosen once from the mode in pipeline/create-deps.ts).

export const META_CHANNEL_PLATFORMS = ['instagram', 'facebook'] as const;
export type MetaChannelPlatform = (typeof META_CHANNEL_PLATFORMS)[number];

export interface StoredMetaCredentialDeps {
  db: Pick<PrismaClient, 'platformConnection'>;
  keys: DataKeyProvider;
  now: () => number;
  /** Where the user reconnects: 'core' = PostMind settings (default), 'studio' = Connections. */
  reconnectIn?: 'core' | 'studio';
}

const WHERE = {
  core: 'in PostMind settings',
  studio: 'on the Connections page',
} as const;

const reconnect = (platform: string, message: string) =>
  new PlatformError(platform, 'needs_reconnect', message, false);

function whereAccount(ref: MetaAccountRef) {
  return {
    organisationId_platform_platformAccountId: {
      organisationId: ref.organisationId,
      platform: ref.platform,
      platformAccountId: ref.platformAccountId,
    },
  };
}

async function markNeedsReconnect(
  deps: StoredMetaCredentialDeps,
  ref: MetaAccountRef,
): Promise<void> {
  // Only an active connection moves: a revoked one stays revoked (its tokens are already wiped).
  await deps.db.platformConnection.updateMany({
    where: { ...ref, state: 'active' },
    data: { state: 'needs_reconnect' },
  });
}

function usable(
  connection: PlatformConnection | null,
  ref: MetaAccountRef,
  where: string,
): PlatformConnection {
  if (!connection || connection.state === 'revoked' || !connection.encryptedAccessToken)
    throw reconnect(
      ref.platform,
      `This ${ref.platform} account is not connected; connect it ${where}`,
    );
  if (connection.state !== 'active')
    throw reconnect(ref.platform, `The ${ref.platform} connection needs reconnecting ${where}`);
  return connection;
}

export function createStoredMetaCredentials(deps: StoredMetaCredentialDeps): MetaCredentialSource {
  const where = WHERE[deps.reconnectIn ?? 'core'];
  return {
    async getCredentials(ref): Promise<MetaCredentials> {
      const connection = usable(
        await deps.db.platformConnection.findUnique({ where: whereAccount(ref) }),
        ref,
        where,
      );
      if (
        connection.accessTokenExpiresAt &&
        connection.accessTokenExpiresAt.getTime() <= deps.now()
      ) {
        await markNeedsReconnect(deps, ref);
        throw reconnect(
          ref.platform,
          `The ${ref.platform} token has expired; reconnect the account ${where}`,
        );
      }
      const accessToken = await decryptSecret(
        deps.keys,
        connection.encryptedAccessToken,
        tokenContext({
          organisationId: ref.organisationId,
          platform: ref.platform,
          kind: 'access',
        }),
      );
      return {
        accessToken,
        accountId: connection.platformAccountId,
        accountName: connection.platformAccountName,
      };
    },
    async reportTokenRejected(ref) {
      await markNeedsReconnect(deps, ref);
    },
  };
}
